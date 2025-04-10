const dhcp = require('dhcp');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
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
    return 'Ethernet';
}

class DHCPServer {
    constructor(options = {}) {
        this.interface = options.interface || 'eth0';
        this.startIP = options.startIP || '192.168.1.100';
        this.endIP = options.endIP || '192.168.1.200';
        this.subnetMask = options.subnetMask || '255.255.255.0';
        this.gateway = options.gateway || '192.168.1.1';
        this.dns = options.dns || ['8.8.8.8', '8.8.4.4'];
        this.leaseTime = options.leaseTime || 86400;
        this.server = null;
        this.io = null;
    }

    log(message) {
        console.log(message);
        if (this.io) {
            this.io.emit('log', message);
        }
    }

    async start() {
        try {
            this.server = dhcp.createServer({
                interface: this.interface,
                range: [this.startIP, this.endIP],
                netmask: this.subnetMask,
                gateway: this.gateway,
                dns: this.dns,
                leaseTime: this.leaseTime
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
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

const dhcpServer = new DHCPServer({
    interface: getActiveInterface(),
    startIP: '192.168.1.100',
    endIP: '192.168.1.200',
    subnetMask: '255.255.255.0',
    gateway: '192.168.1.1',
    dns: ['8.8.8.8', '8.8.4.4']
});

io.on('connection', (socket) => {
    console.log('Клиент подключился');
    
    socket.emit('server-status', dhcpServer.server ? 'Запущен' : 'Остановлен');
    
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
    console.log('Используемый сетевой интерфейс:', getActiveInterface());
}); 