const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 2e6,
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();
app.use(express.static(__dirname));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function makeCode() {
  let code;
  do { code = String(1000 + crypto.randomInt(0, 9000)); } while (rooms.has(code));
  return code;
}
function getRoom(socket) {
  const code = socket.data.room;
  return code ? rooms.get(code) : null;
}
function leaveRoom(socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.room = null;
  if (!room) return;
  if (room.host === socket.id) {
    for (const id of room.members) io.to(id).emit('room-error', { message: 'Создатель комнаты отключился. Комната закрыта.' });
    for (const id of room.members) {
      const peer = io.sockets.sockets.get(id);
      if (peer) peer.data.room = null;
    }
    rooms.delete(code);
  } else {
    room.members.delete(socket.id);
    if (room.guest === socket.id) room.guest = null;
    io.to(room.host).emit('peer-left');
    if (room.members.size === 0 && !room.started) rooms.delete(code);
  }
}

io.on('connection', socket => {
  socket.on('create-room', () => {
    leaveRoom(socket);
    const code = makeCode();
    const room = { code, host: socket.id, guest: null, members: new Set([socket.id]), started: false };
    rooms.set(code, room);
    socket.data.room = code;
    socket.join(code);
    socket.emit('room-created', { code });
  });

  socket.on('join-room', rawCode => {
    const code = String(rawCode || '').trim();
    if (!/^\d{4}$/.test(code)) return socket.emit('room-error', { message: 'Код должен состоять из 4 цифр.' });
    const room = rooms.get(code);
    if (!room) return socket.emit('room-error', { message: 'Комната не найдена. Проверь код.' });
    if (room.guest && room.guest !== socket.id) return socket.emit('room-error', { message: 'В комнате уже есть второй игрок.' });
    if (room.host === socket.id) return socket.emit('room-error', { message: 'Ты уже создатель этой комнаты.' });
    leaveRoom(socket);
    room.guest = socket.id;
    room.members.add(socket.id);
    socket.data.room = code;
    socket.join(code);
    socket.emit('room-joined', { code });
    io.to(room.host).emit('peer-joined');
  });

  socket.on('start-match', data => {
    const room = getRoom(socket);
    if (!room || room.host !== socket.id || !room.guest) return;
    const difficulty = Number.isInteger(data?.difficulty) ? Math.max(0, Math.min(10, data.difficulty)) : 0;
    const map = Number.isInteger(data?.map) ? Math.max(0, Math.min(10, data.map)) : 0;
    room.started = true;
    io.to(room.guest).emit('start-match', { difficulty, map });
  });

  socket.on('host-snapshot', data => {
    const room = getRoom(socket);
    if (!room || room.host !== socket.id || !room.guest || !room.started) return;
    if (!data || typeof data.g !== 'string' || data.g.length > 1_500_000) return;
    const snapshot = {
      g: data.g,
      tm: Number.isFinite(data.tm) ? data.tm : 0,
      difficulty: Number.isInteger(data.difficulty) ? data.difficulty : 0
    };
    io.to(room.guest).volatile.emit('snapshot', snapshot);
  });

  socket.on('guest-action', data => {
    const room = getRoom(socket);
    if (!room || room.guest !== socket.id || !room.started || !data || typeof data !== 'object') return;
    let safe = null;
    if (data.type === 'click' && typeof data.id === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(data.id)) safe = { type: 'click', id: data.id };
    else if (data.type === 'tower' && Number.isInteger(data.index) && data.index >= 0 && data.index < 100) safe = { type: 'tower', index: data.index };
    else if (data.type === 'pointer' && Number.isFinite(data.x) && Number.isFinite(data.y)) safe = { type: 'pointer', x: Math.max(0, Math.min(1, data.x)), y: Math.max(0, Math.min(1, data.y)) };
    if (safe) io.to(room.host).emit('host-action', safe);
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Zombie co-op server listening on ${PORT}`));
