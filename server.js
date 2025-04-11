const dhcp = require('dhcp');
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const os = require('os');

function getActiveInterface() {
    const interfaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(interfaces)) {
        for (const addr of addrs) {
            if (addr.family === 'IPv4' && !addr.internal) {
                return name;
            }
        }
    }
    return 'eth0';
}

class DHCPServer {
    constructor() {
        this.interface = getActiveInterface();
        this.startIP = '192.168.1.100';
        this.endIP = '192.168.1.200';
        this.subnetMask = '255.255.255.0';
        this.gateway = '192.168.1.1';
        this.dns = ['8.8.8.8', '8.8.4.4'];
        this.leaseTime = 86400;
        this.server = null;
        this.leases = new Map();
        this.reservations = new Map();
        this.io = null;
    }

    log(message) {
        console.log(`[DHCP] ${message}`);
        if (this.io) {
            this.io.emit('log', message);
        }
    }

    ipToNumber(ip) {
        return ip.split('.')
            .reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
    }

    numberToIp(num) {
        return [
            (num >>> 24) & 255,
            (num >>> 16) & 255,
            (num >>> 8) & 255,
            num & 255
        ].join('.');
    }

    isIpInRange(ip) {
        const ipNum = this.ipToNumber(ip);
        const startNum = this.ipToNumber(this.startIP);
        const endNum = this.ipToNumber(this.endIP);
        return ipNum >= startNum && ipNum <= endNum;
    }

    isIpReserved(mac, ip) {
        return this.reservations.has(mac) && this.reservations.get(mac) === ip;
    }

    updateSettings(settings) {
        this.startIP = settings.startIP;
        this.endIP = settings.endIP;
        this.subnetMask = settings.subnetMask;
        this.gateway = settings.gateway;
        this.dns = settings.dns;
        this.leaseTime = settings.leaseTime;

        if (this.server) {
            this.stop();
            this.start();
        }

        this.log('Настройки сервера обновлены');
        if (this.io) {
            this.io.emit('settings-update', {
                startIP: this.startIP,
                endIP: this.endIP,
                subnetMask: this.subnetMask,
                gateway: this.gateway,
                dns: this.dns,
                leaseTime: this.leaseTime
            });
        }
    }

    addReservation(mac, ip) {
        if (!this.isIpInRange(ip)) {
            this.log(`Ошибка: IP ${ip} вне допустимого диапазона`);
            return false;
        }

        this.reservations.set(mac, ip);
        this.log(`Добавлено резервирование: ${mac} -> ${ip}`);
        
        if (this.io) {
            this.io.emit('reservations-update', Object.fromEntries(this.reservations));
        }
        return true;
    }

    removeReservation(mac) {
        if (this.reservations.has(mac)) {
            const ip = this.reservations.get(mac);
            this.reservations.delete(mac);
            this.log(`Удалено резервирование: ${mac} -> ${ip}`);
            
            if (this.io) {
                this.io.emit('reservations-update', Object.fromEntries(this.reservations));
            }
            return true;
        }
        return false;
    }

    start() {
        if (this.server) {
            this.log('Сервер уже запущен');
            return;
        }

        try {
            this.server = dhcp.createServer({
                interface: this.interface,
                range: [this.startIP, this.endIP],
                netmask: this.subnetMask,
                gateway: this.gateway,
                dns: this.dns,
                leaseTime: this.leaseTime,
                forceOptions: ['hostname', 'domainName', 'domainSearch', 'ntpServers'],
                static: Object.fromEntries(this.reservations),
                log: (msg) => this.log(msg)
            });

            this.server.on('message', (data) => {
                const { type, message } = data;
                this.log(`DHCP ${type}: ${message}`);
            });

            this.server.on('listening', () => {
                this.log(`DHCP сервер запущен на интерфейсе ${this.interface}`);
                if (this.io) {
                    this.io.emit('server-status', 'Запущен');
                }
            });

            this.server.on('error', (err) => {
                this.log(`Ошибка DHCP сервера: ${err.message}`);
                if (this.io) {
                    this.io.emit('server-status', 'Ошибка');
                }
            });

            this.server.on('bound', (state) => {
                const { mac, ip, expires } = state;
                this.leases.set(mac, {
                    ip,
                    startTime: Date.now(),
                    expires: Date.now() + (expires * 1000)
                });
                this.log(`Клиент ${mac} получил IP ${ip}`);
                if (this.io) {
                    this.io.emit('leases-update', Object.fromEntries(this.leases));
                }
            });

            this.server.on('release', (state) => {
                const { mac } = state;
                if (this.leases.has(mac)) {
                    this.leases.delete(mac);
                    this.log(`Клиент ${mac} освободил IP`);
                    if (this.io) {
                        this.io.emit('leases-update', Object.fromEntries(this.leases));
                    }
                }
            });

            this.server.listen();
        } catch (error) {
            this.log(`Ошибка при запуске сервера: ${error.message}`);
            if (this.io) {
                this.io.emit('server-status', 'Ошибка');
            }
        }
    }

    stop() {
        if (!this.server) {
            this.log('Сервер не запущен');
            return;
        }

        try {
            this.server.close();
            this.server = null;
            this.log('DHCP сервер остановлен');
            if (this.io) {
                this.io.emit('server-status', 'Остановлен');
            }
        } catch (error) {
            this.log(`Ошибка при остановке сервера: ${error.message}`);
        }
    }
}

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const dhcpServer = new DHCPServer();

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log('Клиент подключился');

    socket.emit('settings-update', {
        startIP: dhcpServer.startIP,
        endIP: dhcpServer.endIP,
        subnetMask: dhcpServer.subnetMask,
        gateway: dhcpServer.gateway,
        dns: dhcpServer.dns,
        leaseTime: dhcpServer.leaseTime
    });

    socket.emit('reservations-update', Object.fromEntries(dhcpServer.reservations));

    socket.emit('leases-update', Object.fromEntries(dhcpServer.leases));

    socket.on('get-settings', () => {
        socket.emit('settings-update', {
            startIP: dhcpServer.startIP,
            endIP: dhcpServer.endIP,
            subnetMask: dhcpServer.subnetMask,
            gateway: dhcpServer.gateway,
            dns: dhcpServer.dns,
            leaseTime: dhcpServer.leaseTime
        });
    });

    socket.on('get-reservations', () => {
        socket.emit('reservations-update', Object.fromEntries(dhcpServer.reservations));
    });

    socket.on('update-settings', (settings) => {
        dhcpServer.updateSettings(settings);
    });

    socket.on('add-reservation', ({ mac, ip }) => {
        dhcpServer.addReservation(mac, ip);
    });

    socket.on('remove-reservation', (mac) => {
        dhcpServer.removeReservation(mac);
    });

    socket.on('start-server', () => {
        dhcpServer.start();
    });

    socket.on('stop-server', () => {
        dhcpServer.stop();
    });

    socket.on('disconnect', () => {
        console.log('Клиент отключился');
    });
});

dhcpServer.io = io;

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
}); 