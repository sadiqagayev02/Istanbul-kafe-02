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

// Data qovluğu yarat
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// In-memory storage
let orders = [];
const connectedAdmins = new Set();
const connectedClients = new Map();

// Gəlir storage - fayldan yüklə
let dailyRevenue = {};
const revenuePath = path.join(dataDir, 'revenue.json');

try {
    if (fs.existsSync(revenuePath)) {
        dailyRevenue = JSON.parse(fs.readFileSync(revenuePath, 'utf8'));
        console.log(`💰 Gəlir məlumatları yükləndi: ${Object.keys(dailyRevenue).length} gün`);
    }
} catch (e) {
    console.log('💰 Yeni gəlir storage başladı');
}

// Gəliri fayla yaz
function saveRevenueToFile() {
    try {
        fs.writeFileSync(revenuePath, JSON.stringify(dailyRevenue, null, 2));
    } catch (e) {
        console.error('❌ Gəlir fayla yazılmadı:', e);
    }
}

// Generate unique ID
const generateId = () => {
    const date = new Date();
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `ORD-${day}${month}-${hours}${minutes}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
};

// ============================================
// GƏLİR FUNKSİYALARI
// ============================================
function saveOrderToRevenue(order) {
    const date = new Date(order.timestamp).toISOString().split('T')[0];
    const hour = new Date(order.timestamp).getHours();
    
    // Yalnız 09:00-21:00 arası
    if (hour < 9 || hour >= 21) return;
    
    if (!dailyRevenue[date]) {
        dailyRevenue[date] = { total: 0, table: 0, delivery: 0, tableCount: 0, deliveryCount: 0 };
    }
    
    dailyRevenue[date].total += order.total || 0;
    if (order.orderType === 'table' || order.table) {
        dailyRevenue[date].table += order.total || 0;
        dailyRevenue[date].tableCount++;
    } else {
        dailyRevenue[date].delivery += order.total || 0;
        dailyRevenue[date].deliveryCount++;
    }
    
    saveRevenueToFile();
    console.log(`💰 Gəlir yeniləndi: ${date} - ${dailyRevenue[date].total.toFixed(2)} AZN`);
}

function resetRevenueStorage() {
    dailyRevenue = {};
    saveRevenueToFile();
    console.log('💰 Gəlir statistikası sıfırlandı');
}

// ============================================
// WEBSOCKET SERVER
// ============================================
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    const clientId = crypto.randomBytes(8).toString('hex');
    
    console.log(`🔗 Yeni bağlantı: ${clientId}`);
    
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
                    orders: orders.slice(-100).reverse(),
                    revenue: dailyRevenue
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
            
        case 'DELETE_ORDER':
            handleDeleteOrder(ws, data);
            break;
            
        case 'CLEAR_ORDERS':
            handleClearOrders(ws, data);
            break;
            
        case 'UPDATE_REVENUE':
            if (data.secret === process.env.ADMIN_SECRET) {
                dailyRevenue = data.revenue;
                saveRevenueToFile();
                broadcastToAdmins({
                    type: 'REVENUE_UPDATED',
                    revenue: dailyRevenue
                });
            }
            break;
            
        case 'RESET_REVENUE':
            if (data.secret === process.env.ADMIN_SECRET) {
                resetRevenueStorage();
                broadcastToAdmins({
                    type: 'REVENUE_UPDATED',
                    revenue: dailyRevenue
                });
            }
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
    saveOrderToRevenue(order);
    
    console.log(`📦 YENİ SİFARİŞ: ${orderId}`);
    console.log(`   Masa: ${order.table || 'Çatdırılma'}`);
    console.log(`   Müştəri: ${order.customer?.name || 'Anonim'}`);
    console.log(`   Məbləğ: ${order.total?.toFixed(2)} AZN`);
    console.log(`   Məhsul sayı: ${order.items?.length || 0}`);
    if (order.note) console.log(`   Qeyd: ${order.note}`);
    
    ws.send(JSON.stringify({
        type: 'ORDER_CONFIRMED',
        orderId,
        message: 'Sifarişiniz qəbul edildi!',
        estimatedTime: '20-30 dəqiqə'
    }));
    
    broadcastToAdmins({
        type: 'NEW_ORDER',
        order,
        notification: {
            title: '🛎️ Yeni Sifariş!',
            body: `${order.table ? `Masa ${order.table}` : 'Çatdırılma'} - ${order.customer?.name || 'Anonim'} - ${order.total?.toFixed(2)} AZN`,
            sound: true,
            priority: 'high'
        }
    });
    
    broadcastToAdmins({
        type: 'REVENUE_UPDATED',
        revenue: dailyRevenue
    });
}

// Handle Order Status Update
function handleOrderStatusUpdate(ws, data) {
    if (!ws.isAdmin) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Bu əməliyyat üçün admin hüququ lazımdır' }));
        return;
    }
    
    const order = orders.find(o => o.id === data.orderId);
    if (!order) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Sifariş tapılmadı' }));
        return;
    }
    
    order.status = data.status;
    order.updatedAt = new Date().toISOString();
    
    console.log(`📝 Sifariş ${order.id} status: ${order.status}`);
    
    const clientWs = Array.from(wss.clients).find(c => c.clientId === order.wsClientId);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
            type: 'ORDER_STATUS_UPDATED',
            orderId: order.id,
            status: order.status,
            message: getStatusMessage(order.status)
        }));
    }
    
    broadcastToAdmins({ type: 'ORDER_UPDATED', order });
}

// Handle Delete Order
function handleDeleteOrder(ws, data) {
    const isAdminBySecret = data.secret === process.env.ADMIN_SECRET;
    if (!ws.isAdmin && !isAdminBySecret) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Bu əməliyyat üçün admin hüququ lazımdır' }));
        return;
    }
    
    const orderId = data.orderId;
    const orderExists = orders.find(o => o.id === orderId);
    
    if (!orderExists) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Sifariş tapılmadı' }));
        return;
    }
    
    orders = orders.filter(o => o.id !== orderId);
    console.log(`🗑️ Sifariş silindi: ${orderId}`);
    
    broadcastToAdmins({ type: 'ORDER_DELETED', orderId });
}

// Handle Clear All Orders
function handleClearOrders(ws, data) {
    const isAdminBySecret = data.secret === process.env.ADMIN_SECRET;
    if (!ws.isAdmin && !isAdminBySecret) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Bu əməliyyat üçün admin hüququ lazımdır' }));
        return;
    }
    
    const deletedCount = orders.length;
    orders = [];
    console.log(`🗑️ BÜTÜN SİFARİŞLƏR SİLİNDİ (${deletedCount} ədəd)`);
    
    broadcastToAdmins({ type: 'ORDERS_CLEARED', count: deletedCount });
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

app.get('/api/orders/check-new', (req, res) => {
    const lastCheck = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 10000);
    const newOrders = orders.filter(o => new Date(o.timestamp) > lastCheck);
    
    res.json({ success: true, newOrders: newOrders.length, orders: newOrders });
});

app.get('/api/orders', (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    
    const { limit = 100, status } = req.query;
    let filteredOrders = orders;
    if (status) filteredOrders = orders.filter(o => o.status === status);
    
    res.json({ success: true, count: filteredOrders.length, orders: filteredOrders.slice(-parseInt(limit)).reverse() });
});

app.get('/api/orders/:orderId', (req, res) => {
    const { orderId } = req.params;
    const order = orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Sifariş tapılmadı' });
    res.json({ success: true, order });
});

app.post('/api/orders', (req, res) => {
    const orderData = req.body;
    const orderId = generateId();
    
    const order = { id: orderId, ...orderData, timestamp: new Date().toISOString(), status: 'pending' };
    
    orders.push(order);
    saveOrderToRevenue(order);
    
    console.log(`📦 HTTP Sifariş: ${orderId}`);
    if (order.note) console.log(`   Qeyd: ${order.note}`);
    
    broadcastToAdmins({
        type: 'NEW_ORDER',
        order,
        notification: {
            title: '🛎️ Yeni Sifariş (HTTP)',
            body: `${order.table ? `Masa ${order.table}` : 'Çatdırılma'} - ${order.total?.toFixed(2)} AZN`,
            sound: true
        }
    });
    
    broadcastToAdmins({ type: 'REVENUE_UPDATED', revenue: dailyRevenue });
    
    res.json({ success: true, orderId, message: 'Sifariş qəbul edildi', estimatedTime: '20-30 dəqiqə' });
});

app.patch('/api/orders/:orderId', (req, res) => {
    const { orderId } = req.params;
    const { secret, status } = req.body;
    
    if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    
    const order = orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Sifariş tapılmadı' });
    
    order.status = status;
    order.updatedAt = new Date().toISOString();
    
    broadcastToAdmins({ type: 'ORDER_UPDATED', order });
    res.json({ success: true, order });
});

app.delete('/api/orders/:orderId', (req, res) => {
    const { orderId } = req.params;
    const { secret } = req.body;
    
    if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    
    const orderExists = orders.find(o => o.id === orderId);
    if (!orderExists) return res.status(404).json({ error: 'Sifariş tapılmadı' });
    
    orders = orders.filter(o => o.id !== orderId);
    broadcastToAdmins({ type: 'ORDER_DELETED', orderId });
    res.json({ success: true, message: 'Sifariş silindi' });
});

app.delete('/api/orders', (req, res) => {
    const { secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    
    const deletedCount = orders.length;
    orders = [];
    broadcastToAdmins({ type: 'ORDERS_CLEARED', count: deletedCount });
    res.json({ success: true, message: `${deletedCount} sifariş silindi` });
});

app.get('/api/revenue', (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ success: true, revenue: dailyRevenue });
});

app.post('/api/revenue/reset', (req, res) => {
    const { secret } = req.body;
    if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    
    resetRevenueStorage();
    broadcastToAdmins({ type: 'REVENUE_UPDATED', revenue: dailyRevenue });
    res.json({ success: true, message: 'Gəlir sıfırlandı' });
});

app.get('/api/stats', (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    
    const today = new Date().toISOString().split('T')[0];
    const todayOrders = orders.filter(o => o.timestamp.startsWith(today));
    const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const todayRevenue = todayOrders.reduce((sum, o) => sum + (o.total || 0), 0);
    
    res.json({
        success: true,
        stats: {
            totalOrders: orders.length,
            todayOrders: todayOrders.length,
            totalRevenue,
            todayRevenue,
            activeAdmins: connectedAdmins.size,
            connectedClients: wss.clients.size,
            statusCounts: {
                pending: orders.filter(o => o.status === 'pending').length,
                preparing: orders.filter(o => o.status === 'preparing').length,
                ready: orders.filter(o => o.status === 'ready').length,
                delivered: orders.filter(o => o.status === 'delivered').length,
                completed: orders.filter(o => o.status === 'completed').length,
                cancelled: orders.filter(o => o.status === 'cancelled').length
            }
        }
    });
});

app.post('/api/admin/auth', (req, res) => {
    const { secret } = req.body;
    if (secret === process.env.ADMIN_SECRET) {
        res.json({ success: true, message: 'Admin auth successful', token: crypto.createHash('sha256').update(secret + Date.now()).digest('hex') });
    } else {
        res.status(401).json({ success: false, error: 'Invalid secret' });
    }
});

// Serve HTML pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/qrcodes', (req, res) => res.sendFile(path.join(__dirname, 'public', 'qrcodes.html')));
app.get('/menu', (req, res) => res.redirect(`/?table=${req.query.table || '1'}`));

app.use((req, res) => res.status(404).json({ error: 'Endpoint tapılmadı' }));
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
║         Menyu: http://localhost:${PORT}/menu               ║
║                                                          ║
║         Admin Secret: ${process.env.ADMIN_SECRET || '!!! QURULMAYIB !!!'}${' '.repeat(20)}║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
    `);
});

process.on('SIGTERM', () => {
    console.log('👋 SIGTERM alındı, server bağlanır...');
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('👋 SIGINT alındı, server bağlanır...');
    server.close(() => process.exit(0));
});

module.exports = { app, server, wss };
