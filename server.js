const dhcp = require('dhcp');
const Netmask = require('netmask').Netmask;
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

// DHCP константы
const DHCP_MESSAGE_TYPES = {
    DISCOVER: 1,
    OFFER: 2,
    REQUEST: 3,
    DECLINE: 4,
    ACK: 5,
    NAK: 6,
    RELEASE: 7,
    INFORM: 8
};

class DHCPServer {
    constructor(options = {}) {
        this.interface = options.interface || 'eth0';
        this.startIP = options.startIP || '192.168.1.100';
        this.endIP = options.endIP || '192.168.1.200';
        this.subnetMask = options.subnetMask || '255.255.255.0';
        this.gateway = options.gateway || '192.168.1.1';
        this.dns = options.dns || ['8.8.8.8', '8.8.4.4'];
        this.leaseTime = options.leaseTime || 86400; 
        
        this.leases = new Map(); // Map<MAC, {ip: string, expires: number}>
        this.server = null;
        this.io = null;
        
     
        this.startIPNum = this.ipToNumber(this.startIP);
        this.endIPNum = this.ipToNumber(this.endIP);
    }

    ipToNumber(ip) {
        return ip.split('.')
            .reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
    }

    numberToIP(num) {
        return [
            (num >>> 24) & 255,
            (num >>> 16) & 255,
            (num >>> 8) & 255,
            num & 255
        ].join('.');
    }

    getNextAvailableIP() {
        for (let ipNum = this.startIPNum; ipNum <= this.endIPNum; ipNum++) {
            const ip = this.numberToIP(ipNum);
            let isAvailable = true;
            
            for (const lease of this.leases.values()) {
                if (lease.ip === ip && lease.expires > Date.now()) {
                    isAvailable = false;
                    break;
                }
            }
            
            if (isAvailable) {
                return ip;
            }
        }
        return null;
    }

    log(message) {
        console.log(message);
        if (this.io) {
            this.io.emit('log', message);
        }
    }

    updateLeases() {
        if (this.io) {
            const leasesObj = {};
            for (const [mac, lease] of this.leases.entries()) {
                leasesObj[mac] = {
                    ...lease,
                    startTime: lease.startTime || Date.now()
                };
            }
            this.io.emit('leases-update', leasesObj);
        }
    }

    async start() {
        try {
            // Создаем DHCP сервер
            this.server = dhcp.createServer({
                interface: this.interface,
                range: [this.startIP, this.endIP],
                netmask: this.subnetMask,
                gateway: this.gateway,
                dns: this.dns,
                leaseTime: this.leaseTime,
                offer: (data, send) => {
                    this.log(`Получен DHCP DISCOVER от ${data.mac}`);
                    const availableIP = this.getNextAvailableIP();
                    if (availableIP) {
                        send({
                            address: availableIP,
                            netmask: this.subnetMask,
                            gateway: this.gateway,
                            dns: this.dns
                        });
                    }
                },
                request: (data, send) => {
                    this.log(`Получен DHCP REQUEST от ${data.mac}`);
                    const requestedIP = data.requestedIP;
                    if (requestedIP && this.isIPInRange(requestedIP)) {
                        send({
                            address: requestedIP,
                            netmask: this.subnetMask,
                            gateway: this.gateway,
                            dns: this.dns
                        });
                        
                        // Сохраняем информацию об аренде
                        this.leases.set(data.mac, {
                            ip: requestedIP,
                            expires: Date.now() + (this.leaseTime * 1000),
                            startTime: Date.now()
                        });
                        
                        this.updateLeases();
                    } else {
                        send();
                    }
                },
                release: (data) => {
                    this.log(`Получен DHCP RELEASE от ${data.mac}`);
                    this.leases.delete(data.mac);
                    this.updateLeases();
                }
            });

            this.server.listen();
            this.log(`DHCP сервер запущен на интерфейсе ${this.interface}`);
            this.log(`Диапазон IP: ${this.startIP} - ${this.endIP}`);
            
            if (this.io) {
                this.io.emit('server-status', 'Запущен');
            }
        } catch (error) {
            this.log('Ошибка при запуске сервера: ' + error.message);
            if (this.io) {
                this.io.emit('server-status', 'Ошибка');
            }
        }
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        this.log('DHCP сервер остановлен');
        if (this.io) {
            this.io.emit('server-status', 'Остановлен');
        }
    }

    isIPInRange(ip) {
        const ipNum = this.ipToNumber(ip);
        return ipNum >= this.startIPNum && ipNum <= this.endIPNum;
    }
}


const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

// Создание и настройка DHCP сервера
const dhcpServer = new DHCPServer({
    interface: 'eth0',
    startIP: '192.168.1.100',
    endIP: '192.168.1.200',
    subnetMask: '255.255.255.0',
    gateway: '192.168.1.1',
    dns: ['8.8.8.8', '8.8.4.4']
});

// WebSocket
io.on('connection', (socket) => {
    console.log('Клиент подключился к веб-интерфейсу');
    
    socket.on('start-server', () => {
        dhcpServer.io = io;
        dhcpServer.start();
    });
    
    socket.on('stop-server', () => {
        dhcpServer.stop();
    });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Веб-интерфейс доступен по адресу http://localhost:${PORT}`);
}); 