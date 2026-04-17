const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(require('cors')());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage
const orders = [];
const connectedAdmins = new Set();
const connectedClients = new Map();

// Generate unique ID
const generateId = () => `ORD-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

// ============================================
// WEBSOCKET SERVER
// ============================================
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    const clientId = crypto.randomBytes(8).toString('hex');
    
    console.log(`🔗 Yeni bağlantı: ${clientId} (${clientIp})`);
    
    ws.clientId = clientId;
    ws.isAdmin = false;
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleWebSocketMessage(ws, data);
        } catch (error) {
            console.error('❌ WebSocket mesaj xətası:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`🔌 Bağlantı kəsildi: ${ws.clientId}`);
        
        if (ws.isAdmin) {
            connectedAdmins.delete(ws);
            console.log(`👑 Admin çıxdı. Aktiv admin sayı: ${connectedAdmins.size}`);
        }
        
        if (ws.tableId) {
            connectedClients.delete(ws.tableId);
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket xətası:', error);
    });
    
    // Ping/Pong for keeping connection alive
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
});

// Keep connections alive
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(pingInterval);
});

// WebSocket Message Handler
function handleWebSocketMessage(ws, data) {
    switch (data.type) {
        case 'REGISTER_ADMIN':
            if (data.secret === process.env.ADMIN_SECRET) {
                ws.isAdmin = true;
                connectedAdmins.add(ws);
                
                ws.send(JSON.stringify({
                    type: 'ADMIN_REGISTERED',
                    message: 'Admin panelə qoşuldu',
                    orders: orders.slice(-50) // Son 50 sifarişi göndər
                }));
                
                console.log(`👑 Admin qeydiyyatdan keçdi. Aktiv admin: ${connectedAdmins.size}`);
            } else {
                ws.send(JSON.stringify({
                    type: 'ERROR',
                    message: 'Səhv admin şifrəsi'
                }));
            }
            break;
            
        case 'REGISTER_TABLE':
            ws.tableId = data.tableNumber;
            connectedClients.set(data.tableNumber, ws);
            
            ws.send(JSON.stringify({
                type: 'TABLE_REGISTERED',
                tableNumber: data.tableNumber,
                message: `Masa ${data.tableNumber} qeydiyyatdan keçdi`
            }));
            
            console.log(`🪑 Masa ${data.tableNumber} qeydiyyatdan keçdi`);
            break;
            
        case 'NEW_ORDER':
            handleNewOrder(ws, data.order);
            break;
            
        case 'UPDATE_ORDER_STATUS':
            handleOrderStatusUpdate(ws, data);
            break;
            
        case 'PING':
            ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
            break;
    }
}

// Handle New Order
function handleNewOrder(ws, orderData) {
    const orderId = generateId();
    const timestamp = new Date().toISOString();
    
    const order = {
        id: orderId,
        ...orderData,
        timestamp,
        status: 'pending',
        wsClientId: ws.clientId
    };
    
    orders.push(order);
    
    // Sifarişi saxla (production-da database-ə yaz)
    console.log(`📦 YENİ SİFARİŞ: ${orderId}`);
    console.log(`   Masa: ${order.table || 'Çatdırılma'}`);
    console.log(`   Müştəri: ${order.customer?.name || 'Anonim'}`);
    console.log(`   Məbləğ: $${order.total?.toFixed(2) || '0.00'}`);
    console.log(`   Məhsul sayı: ${order.items?.length || 0}`);
    
    // Müştəriyə təsdiq göndər
    ws.send(JSON.stringify({
        type: 'ORDER_CONFIRMED',
        orderId,
        message: 'Sifarişiniz qəbul edildi!',
        estimatedTime: '20-30 dəqiqə'
    }));
    
    // Bütün adminlərə bildiriş göndər
    broadcastToAdmins({
        type: 'NEW_ORDER',
        order,
        notification: {
            title: '🛎️ Yeni Sifariş!',
            body: `${order.table ? `Masa ${order.table}` : 'Çatdırılma'} - ${order.customer?.name || 'Anonim'} - $${order.total?.toFixed(2)}`,
            sound: true,
            priority: 'high'
        }
    });
}

// Handle Order Status Update
function handleOrderStatusUpdate(ws, data) {
    if (!ws.isAdmin) {
        ws.send(JSON.stringify({
            type: 'ERROR',
            message: 'Bu əməliyyat üçün admin hüququ lazımdır'
        }));
        return;
    }
    
    const order = orders.find(o => o.id === data.orderId);
    if (!order) {
        ws.send(JSON.stringify({
            type: 'ERROR',
            message: 'Sifariş tapılmadı'
        }));
        return;
    }
    
    order.status = data.status;
    order.updatedAt = new Date().toISOString();
    
    console.log(`📝 Sifariş ${order.id} status: ${order.status}`);
    
    // Müştəriyə status yeniləməsi göndər
    const clientWs = Array.from(wss.clients).find(c => c.clientId === order.wsClientId);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
            type: 'ORDER_STATUS_UPDATED',
            orderId: order.id,
            status: order.status,
            message: getStatusMessage(order.status)
        }));
    }
    
    // Admin paneli yenilə
    broadcastToAdmins({
        type: 'ORDER_UPDATED',
        order
    });
}

// Status mesajları
function getStatusMessage(status) {
    const messages = {
        'pending': 'Sifarişiniz qəbul edildi, hazırlanır',
        'preparing': 'Sifarişiniz hazırlanır',
        'ready': 'Sifarişiniz hazırdır!',
        'delivered': 'Sifarişiniz çatdırıldı',
        'completed': 'Sifariş tamamlandı',
        'cancelled': 'Sifariş ləğv edildi'
    };
    return messages[status] || 'Status yeniləndi';
}

// Broadcast to all admins
function broadcastToAdmins(data) {
    let sentCount = 0;
    connectedAdmins.forEach((adminWs) => {
        if (adminWs.readyState === WebSocket.OPEN) {
            adminWs.send(JSON.stringify(data));
            sentCount++;
        }
    });
    console.log(`📢 ${sentCount} adminə bildiriş göndərildi`);
}

// ============================================
// REST API ENDPOINTS
// ============================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        connections: wss.clients.size,
        admins: connectedAdmins.size,
        orders: orders.length
    });
});

// Get all orders (admin only)
app.get('/api/orders', (req, res) => {
    const { secret } = req.query;
    
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { limit = 100, status } = req.query;
    let filteredOrders = orders;
    
    if (status) {
        filteredOrders = orders.filter(o => o.status === status);
    }
    
    res.json({
        success: true,
        count: filteredOrders.length,
        orders: filteredOrders.slice(-parseInt(limit))
    });
});

// Get single order
app.get('/api/orders/:orderId', (req, res) => {
    const { orderId } = req.params;
    const order = orders.find(o => o.id === orderId);
    
    if (!order) {
        return res.status(404).json({ error: 'Sifariş tapılmadı' });
    }
    
    res.json({ success: true, order });
});

// Create new order (HTTP fallback)
app.post('/api/orders', (req, res) => {
    const orderData = req.body;
    const orderId = generateId();
    
    const order = {
        id: orderId,
        ...orderData,
        timestamp: new Date().toISOString(),
        status: 'pending'
    };
    
    orders.push(order);
    
    console.log(`📦 HTTP Sifariş: ${orderId}`);
    
    // Adminlərə bildiriş
    broadcastToAdmins({
        type: 'NEW_ORDER',
        order,
        notification: {
            title: '🛎️ Yeni Sifariş (HTTP)',
            body: `${order.table ? `Masa ${order.table}` : 'Çatdırılma'} - $${order.total?.toFixed(2)}`,
            sound: true
        }
    });
    
    res.json({
        success: true,
        orderId,
        message: 'Sifariş qəbul edildi',
        estimatedTime: '20-30 dəqiqə'
    });
});

// Update order status (admin only)
app.patch('/api/orders/:orderId', (req, res) => {
    const { orderId } = req.params;
    const { secret, status } = req.body;
    
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const order = orders.find(o => o.id === orderId);
    if (!order) {
        return res.status(404).json({ error: 'Sifariş tapılmadı' });
    }
    
    order.status = status;
    order.updatedAt = new Date().toISOString();
    
    broadcastToAdmins({
        type: 'ORDER_UPDATED',
        order
    });
    
    res.json({ success: true, order });
});

// Get statistics (admin only)
app.get('/api/stats', (req, res) => {
    const { secret } = req.query;
    
    if (secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const today = new Date().toISOString().split('T')[0];
    const todayOrders = orders.filter(o => o.timestamp.startsWith(today));
    
    const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const todayRevenue = todayOrders.reduce((sum, o) => sum + (o.total || 0), 0);
    
    const statusCounts = {
        pending: orders.filter(o => o.status === 'pending').length,
        preparing: orders.filter(o => o.status === 'preparing').length,
        ready: orders.filter(o => o.status === 'ready').length,
        delivered: orders.filter(o => o.status === 'delivered').length,
        completed: orders.filter(o => o.status === 'completed').length,
        cancelled: orders.filter(o => o.status === 'cancelled').length
    };
    
    res.json({
        success: true,
        stats: {
            totalOrders: orders.length,
            todayOrders: todayOrders.length,
            totalRevenue,
            todayRevenue,
            activeAdmins: connectedAdmins.size,
            connectedClients: wss.clients.size,
            statusCounts
        }
    });
});

// Admin auth check
app.post('/api/admin/auth', (req, res) => {
    const { secret } = req.body;
    
    if (secret === process.env.ADMIN_SECRET) {
        res.json({
            success: true,
            message: 'Admin auth successful',
            token: crypto.createHash('sha256').update(secret + Date.now()).digest('hex')
        });
    } else {
        res.status(401).json({ success: false, error: 'Invalid secret' });
    }
});

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/qrcodes', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'qrcodes.html'));
});

app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint tapılmadı' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('❌ Server xətası:', err);
    res.status(500).json({ error: 'Server xətası baş verdi' });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║         🍽️  İSTANBUL KAFE - SİFARİŞ SİSTEMİ  🍽️        ║
║                                                          ║
║         Server başladı: http://localhost:${PORT}           ║
║         Admin panel: http://localhost:${PORT}/admin        ║
║         QR Kodlar: http://localhost:${PORT}/qrcodes        ║
║                                                          ║
║         WebSocket: ws://localhost:${PORT}                  ║
║         Admin Secret: ${process.env.ADMIN_SECRET}          ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM alındı, server bağlanır...');
    server.close(() => {
        console.log('✅ Server bağlandı');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('👋 SIGINT alındı, server bağlanır...');
    server.close(() => {
        console.log('✅ Server bağlandı');
        process.exit(0);
    });
});

module.exports = { app, server, wss };