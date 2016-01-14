import _ from 'lodash';
import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import { parseText } from 'gcode-parser';
import pubsub from 'pubsub-js';
import readline from 'readline';
import serialport, { SerialPort } from 'serialport';
import socketIO from 'socket.io';
import log from './lib/log';
import CommandQueue from './CommandQueue';
import settings from './config/settings';
import store from './store';

//
// Grbl 0.9j ['$' for help]
//
const matchGrblInitializationMessage = (msg) => {
    return msg.match(/^Grbl/i);
};

//
// > ?
// <Idle,MPos:5.529,0.560,7.000,WPos:1.529,-5.440,-0.000>
//
const matchGrblCurrentStatus = (msg) => {
    return msg.match(/<(\w+),\w+:([^,]+),([^,]+),([^,]+),\w+:([^,]+),([^,]+),([^,]+)>/);
};

//
// Example
// > $G
// [G0 G54 G17 G21 G90 G94 M0 M5 M9 T0 F2540. S0.]
//
const matchGrblGCodeModes = (msg) => {
    return msg.match(/\[(?:\w+[0-9]+\.?[0-9]*\s*)+\]/);
};

pubsub.subscribe('file:upload', (msg, data) => {
    let meta = data.meta || {};
    let gcode = data.contents || '';

    parseText(gcode, (err, data) => {
        if (err) {
            log.error('Failed to parse the G-code', err, gcode);
            return;
        }

        let lines = _.pluck(data, 'line');
        let port = meta.port;
        let sp = store.connection[port];

        if (!(sp && sp.queue)) {
            log.error('Failed to add %s to the queue: port=%s', JSON.stringify(meta.name), JSON.stringify(port));
            return;
        }

        // Load G-code
        sp.gcode = gcode;

        // Stop and clear queue
        sp.queue.stop();
        sp.queue.clear();

        sp.queue.push(lines);

        log.debug('Added %d lines to the queue: port=%s', lines.length, JSON.stringify(port));
    });
});

module.exports = (server) => {
    let io = socketIO(server, {
        serveClient: true,
        path: '/socket.io'
    });

    io.on('connection', (socket) => {
        log.debug('io.on(%s):', 'connection', { id: socket.id });

        socket.on('disconnect', () => {
            log.debug('socket.on(%s):', 'disconnect', { id: socket.id });

            // Remove the socket of the disconnected client
            _.each(store.connection, (sp) => {
                sp.sockets[socket.id] = undefined;
                delete sp.sockets[socket.id];
            });
        });

        socket.on('list', () => {
            log.debug('socket.on(%s):', 'list', { id: socket.id });

            serialport.list((err, ports) => {
                if (err) {
                    log.error(err);
                    return;
                }

                ports = ports.concat(_.get(settings, 'cnc.ports') || []);

                let portsInUse = _(store.connection)
                    .filter((sp) => {
                        return sp.serialPort && sp.serialPort.isOpen();
                    })
                    .map((sp) => {
                        return sp.port;
                    })
                    .value();
                
                ports = _.map(ports, (port) => {
                    return {
                        port: port.comName,
                        manufacturer: port.manufacturer,
                        inuse: _.includes(portsInUse, port.comName) ? true : false
                    };
                });

                log.debug('serialport.list():', ports);
                socket.emit('serialport:list', ports);
            });
        });

        socket.on('open', (port, baudrate) => {
            log.debug('socket.on(%s):', 'open', { id: socket.id, port: port, baudrate: baudrate });

            let sp = store.connection[port] = store.connection[port] || {
                port: port,
                ready: false,
                pending: {
                    '?': false, // current status
                    '$G': false, // view gcode parser state
                    '$G:rsp': false // Grbl response: 'ok' or 'error'
                },
                timer: {},
                serialPort: null,
                gcode: '',
                queue: null,
                q_total: 0,
                q_executed: 0,
                sockets: {
                    // socket.id: { socket: socket, command: command }
                },
                emit: (() => {
                    return (evt, msg) => {
                        _.each(sp.sockets, (o, id) => {
                            if (_.isUndefined(o) || !(_.isObject(o.socket))) {
                                log.error('Cannot call method \'emit\' of undefined socket:', { id: id });
                                return;
                            }
                            o.socket.emit(evt, msg);
                        });
                    };
                })()
            };

            if (!(sp.timer['grbl:query'])) {
                sp.timer['grbl:query'] = setInterval(() => {
                    if (!(sp.serialPort && sp.serialPort.isOpen())) {
                        return;
                    }

                    if (!(sp.ready)) {
                        // The Grbl is not ready
                        return;
                    }

                    if (!(sp.pending['?'])) {
                        sp.pending['?'] = true;
                        sp.serialPort.write('?');
                    }

                    if (!(sp.pending['$G']) && !(sp.pending['$G:rsp'])) {
                        sp.pending['$G'] = true;
                        sp.serialPort.write('$G' + '\n');
                    }

                }, 250);
            }

            if (!(sp.queue)) {
                sp.queue = new CommandQueue();
                sp.queue.on('data', (msg) => {
                    if (!(sp.serialPort && sp.serialPort.isOpen())) {
                        log.warn('The serial port is not open.', { port: port, msg: msg });
                        return;
                    }

                    let executed = sp.queue.getExecutedCount();
                    let total = sp.queue.size();

                    log.trace('[' + executed + '/' + total + '] ' + msg);

                    msg = ('' + msg).trim();
                    sp.serialPort.write(msg + '\n');
                });
            }

            if (!(sp.timer['queue'])) {
                sp.timer['queue'] = setInterval(() => {
                    if (!(sp.queue)) {
                        return;
                    }

                    let q_executed = sp.queue.getExecutedCount();
                    let q_total = sp.queue.size();

                    if (sp.q_total === q_total && sp.q_executed === q_executed) {
                        return;
                    }

                    sp.q_total = q_total;
                    sp.q_executed = q_executed;

                    sp.emit('gcode:queue-status', {
                        executed: sp.q_executed,
                        total: sp.q_total
                    });

                }, 250);
            }

            if (!(sp.sockets[socket.id])) {
                sp.sockets[socket.id] = {
                    socket: socket,
                    command: ''
                };
            }

            if (sp.serialPort && sp.serialPort.isOpen()) {
                // Emit 'serialport:open' event to the connected socket
                socket.emit('serialport:open', {
                    port: port,
                    baudrate: baudrate,
                    inuse: true
                });
            }

            if (!(sp.serialPort)) {
                try {
                    let serialPort = new SerialPort(port, {
                        baudrate: baudrate,
                        parser: serialport.parsers.readline('\n')
                    });

                    sp.serialPort = serialPort;

                    serialPort.on('open', () => {
                        log.debug('Serial port \'%s\' is connected', port);

                        { // Initialization
                            // Set ready to false
                            sp.ready = false;

                            // Set pending commands to false
                            Object.keys(sp.pending).forEach((cmd) => {
                                sp.pending[cmd] = false;
                            });

                            // Unload G-code
                            sp.gcode = '';

                            // Stop and clear queue
                            sp.queue.stop();
                            sp.queue.clear();
                        }

                        // Emit 'serialport:open' event to the connected socket
                        socket.emit('serialport:open', {
                            port: port,
                            baudrate: baudrate,
                            inuse: true
                        });

                        // Send Ctrl-X to reset Grbl when the serial port connection is established
                        sp.serialPort.write('\x18');
                    });

                    serialPort.on('data', (msg) => {
                        msg = ('' + msg).trim();

                        // Example: Grbl 0.9j ['$' for help]
                        if (matchGrblInitializationMessage(msg)) {
                            // Reset pending commands to false
                            Object.keys(sp.pending).forEach((cmd) => {
                                sp.pending[cmd] = false;
                            });

                            sp.ready = true;
                        }

                        if (matchGrblCurrentStatus(msg)) {
                            let r = msg.match(/<(\w+),\w+:([^,]+),([^,]+),([^,]+),\w+:([^,]+),([^,]+),([^,]+)>/);
                            // https://github.com/grbl/grbl/wiki/Configuring-Grbl-v0.9#---current-status
                            sp.emit('grbl:current-status', {
                                activeState: r[1], // Active States: Idle, Run, Hold, Door, Home, Alarm, Check
                                machinePos: { // Machine position
                                    x: r[2], 
                                    y: r[3],
                                    z: r[4]
                                },
                                workingPos: { // Working position
                                    x: r[5],
                                    y: r[6],
                                    z: r[7]
                                }
                            });

                            _.each(sp.sockets, (o) => {
                                if (o.command === '?') {
                                    o.command = '';
                                    o.socket.emit('serialport:data', msg);
                                }
                            });

                            sp.pending['?'] = false;

                            return;
                        }

                        if (matchGrblGCodeModes(msg)) {
                            let r = msg.match(/\[([^\]]*)\]/);
                            let list = r[1].split(' ');
                            let modes = _(list)
                                .compact()
                                .map((cmd) => {
                                    return _.trim(cmd);
                                })
                                .value();

                            sp.emit('grbl:gcode-modes', modes);

                            _.each(sp.sockets, (o) => {
                                if (o.command.indexOf('$G') === 0) {
                                    o.socket.emit('serialport:data', msg);
                                }
                            });

                            sp.pending['$G'] = false;
                            sp.pending['$G:rsp'] = true; // Wait for Grbl response

                            return;
                        }

                        if ((msg.indexOf('ok') === 0) || (msg.indexOf('error') === 0)) {
                            if (sp.pending['$G:rsp']) {
                                _.each(sp.sockets, (o) => {
                                    if (o.command.indexOf('$G') === 0) {
                                        o.command = ''; // Clear the command buffer
                                        o.socket.emit('serialport:data', msg);
                                    }
                                });
                                sp.pending['$G:rsp'] = false;
                                return;
                            }

                            if (sp.queue.isRunning()) {
                                sp.queue.next();
                                return;
                            }
                        }

                        if (msg.length > 0) {
                            sp.emit('serialport:data', msg);
                        }
                    });

                    serialPort.on('close', () => {
                        log.debug('Serial port \'%s\' is disconnected', port);

                        // Emit 'serialport:close' event to all connected sockets
                        sp.emit('serialport:close', {
                            port: port,
                            inuse: false
                        });

                        store.connection[port] = undefined;
                        delete store.connection[port];
                    });

                    serialPort.on('error', () => {
                        log.error('Error opening serial port \'%s\'', port);

                        // Emit 'serialport:error' event to the first connected socket
                        socket.emit('serialport:error', {
                            port: port
                        });

                        store.connection[port] = undefined;
                        delete store.connection[port];
                    });

                }
                catch (err) {
                    log.error(err);

                    // clear sockets on errors
                    sp.sockets = {};
                }
            }

            log.debug({
                port: port,
                queued: sp.queue.size(),
                sockets: _.keys(sp.sockets)
            });
        });

        socket.on('close', (port) => {
            log.debug('socket.on(%s):', 'close', { id: socket.id, port: port });

            let sp = store.connection[port] || {};
            if (!(sp.serialPort && sp.serialPort.isOpen())) {
                log.warn('The serial port is not open.', { port: port });
                return;
            }

            // Remove socket from the connected port
            sp.sockets[socket.id] = undefined;
            delete sp.sockets[socket.id];

            if (_.size(sp.sockets) === 0) {
                sp.serialPort.close((err) => {
                    if (err) {
                        log.error('Error opening serial port \'%s\'', port);
                    }
                });

                // Delete serial port
                store.connection[port] = undefined;
                delete store.connection[port];
            }

            // Emit 'serialport:close' event
            let inuse = _.size(sp.sockets) > 0;
            socket.emit('serialport:close', {
                port: port,
                inuse: inuse
            });

        });

        socket.on('serialport:write', (port, msg) => {
            log.debug('socket.on(%s):', 'serialport:write', { id: socket.id, port: port, msg: msg });

            let sp = store.connection[port] || {};
            if (!(sp.serialPort && sp.serialPort.isOpen())) {
                log.warn('The serial port is not open.', { port: port, msg: msg });
                return;
            }

            sp.serialPort.write(msg);
            sp.sockets[socket.id].command = msg;
        });

        socket.on('gcode:run', (port) => {
            log.debug('socket.on(%s):', 'gcode:run', { id: socket.id, port: port });

            let sp = store.connection[port] || {};
            if (!(sp.serialPort && sp.serialPort.isOpen())) {
                log.warn('The serial port is not open.', { port: port });
                return;
            }

            sp.queue.play();
        });

        socket.on('gcode:pause', (port) => {
            log.debug('socket.on(%s):', 'gcode:pause', { id: socket.id, port: port });

            let sp = store.connection[port] || {};
            if (!(sp.serialPort && sp.serialPort.isOpen())) {
                log.warn('The serial port is not open.', { port: port });
                return;
            }

            sp.queue.pause();
        });

        socket.on('gcode:stop', (port) => {
            log.debug('socket.on(%s):', 'gcode:stop', { id: socket.id, port: port });

            let sp = store.connection[port] || {};
            if (!(sp.serialPort && sp.serialPort.isOpen())) {
                log.warn('The serial port is not open.', { port: port });
                return;
            }

            sp.queue.stop();
        });

        socket.on('gcode:unload', (port) => {
            log.debug('socket.on(%s):', 'gcode:unload', { id: socket.id, port: port });

            let sp = store.connection[port] || {};
            if (!(sp.serialPort && sp.serialPort.isOpen())) {
                log.warn('The serial port is not open.', { port: port });
                return;
            }

            // Unload G-code
            sp.gcode = '';

            // Clear queue
            sp.queue.clear();
        });

    });
};
