const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const path = require('path');

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// Game state
const rooms = new Map();

// Game constants
const KILL_COOLDOWN = 20000; // 20 seconds
const VOTING_TIME = 30000; // 30 seconds
const TASKS_PER_PLAYER = 3;
const MAP_WIDTH = 1200; // UPDATED: Larger map
const MAP_HEIGHT = 800; // UPDATED: Larger map

// ============ NEW: MAP DEFINITION ============
// Define map walls (rectangles that players cannot pass through)
const MAP_WALLS = [
  // Outer boundaries
  { x: 0, y: 0, width: 1200, height: 20 }, // Top wall
  { x: 0, y: 780, width: 1200, height: 20 }, // Bottom wall
  { x: 0, y: 0, width: 20, height: 800 }, // Left wall
  { x: 1180, y: 0, width: 20, height: 800 }, // Right wall
  
  // Cafeteria walls (top-left)
  { x: 250, y: 20, width: 20, height: 150 },
  { x: 250, y: 170, width: 150, height: 20 },
  
  // Electrical walls (top-right)
  { x: 900, y: 20, width: 20, height: 150 },
  { x: 750, y: 170, width: 150, height: 20 },
  
  // MedBay walls (bottom-left)
  { x: 250, y: 610, width: 20, height: 170 },
  { x: 250, y: 610, width: 150, height: 20 },
  
  // Storage walls (bottom-right)
  { x: 900, y: 610, width: 20, height: 170 },
  { x: 750, y: 610, width: 150, height: 20 },
  
  // Central divider walls
  { x: 400, y: 300, width: 20, height: 200 },
  { x: 780, y: 300, width: 20, height: 200 },
  { x: 420, y: 380, width: 360, height: 20 },
];

// Define room zones with names
const MAP_ROOMS = [
  { name: 'Cafeteria', x: 40, y: 40, width: 210, height: 150 },
  { name: 'Electrical', x: 920, y: 40, width: 240, height: 150 },
  { name: 'MedBay', x: 40, y: 630, width: 210, height: 130 },
  { name: 'Storage', x: 920, y: 630, width: 240, height: 130 },
  { name: 'Upper Hallway', x: 270, y: 40, width: 630, height: 130 },
  { name: 'Lower Hallway', x: 270, y: 630, width: 630, height: 130 },
  { name: 'Left Hallway', x: 40, y: 190, width: 210, height: 440 },
  { name: 'Right Hallway', x: 920, y: 190, width: 240, height: 440 },
  { name: 'Central Hub', x: 420, y: 300, width: 360, height: 300 },
];

// Task locations - UPDATED to match new map
const TASK_LOCATIONS = [
  { x: 100, y: 100, name: 'Download Data' }, // Cafeteria
  { x: 1050, y: 100, name: 'Fix Wiring' }, // Electrical
  { x: 600, y: 100, name: 'Empty Trash' }, // Upper Hallway
  { x: 100, y: 700, name: 'Fuel Engines' }, // MedBay
  { x: 1050, y: 700, name: 'Calibrate' }, // Storage
  { x: 600, y: 400, name: 'Upload Data' }, // Central Hub
  { x: 150, y: 400, name: 'Swipe Card' }, // Left Hallway
  { x: 1000, y: 400, name: 'Inspect Sample' } // Right Hallway
];
// ============ END MAP DEFINITION ============

// Generate random room code
function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Create new room
function createRoom(hostId, hostName) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId,
    players: new Map(),
    state: 'lobby', // lobby, playing, meeting, voting, ended
    impostor: null,
    deadPlayers: new Set(),
    bodies: [],
    meetingCaller: null,
    votes: new Map(),
    votingEndTime: null,
    totalTasks: 0,
    completedTasks: 0,
    killCooldowns: new Map(),
    chatMessages: [] // NEW: Store chat messages during meetings
  };
  
  rooms.set(code, room);
  return room;
}

// Add player to room
function addPlayerToRoom(room, socketId, name) {
  const player = {
    id: socketId,
    name,
    x: 600, // UPDATED: Start in center
    y: 400,
    role: null,
    alive: true,
    tasks: [],
    completedTaskCount: 0
  };
  
  room.players.set(socketId, player);
  return player;
}

// Start game
function startGame(room) {
  const playerArray = Array.from(room.players.values());
  const playerCount = playerArray.length;
  
  // Assign impostor (1 impostor per 5 players)
  const impostorCount = Math.max(1, Math.floor(playerCount / 5));
  const shuffled = [...playerArray].sort(() => Math.random() - 0.5);
  
  for (let i = 0; i < playerCount; i++) {
    const player = shuffled[i];
    if (i < impostorCount) {
      player.role = 'impostor';
      room.impostor = player.id;
    } else {
      player.role = 'crewmate';
      // Assign random tasks
      const availableTasks = [...TASK_LOCATIONS];
      player.tasks = [];
      for (let j = 0; j < TASKS_PER_PLAYER; j++) {
        const idx = Math.floor(Math.random() * availableTasks.length);
        player.tasks.push(availableTasks[idx]);
        availableTasks.splice(idx, 1);
      }
      player.completedTaskCount = 0;
    }
    player.alive = true;
    
    // UPDATED: Spawn in cafeteria area
    player.x = 100 + Math.random() * 100;
    player.y = 60 + Math.random() * 80;
  }
  
  room.state = 'playing';
  room.deadPlayers.clear();
  room.bodies = [];
  room.totalTasks = (playerCount - impostorCount) * TASKS_PER_PLAYER;
  room.completedTasks = 0;
  room.killCooldowns.clear();
  room.chatMessages = []; // NEW: Clear chat messages
}

// Check win conditions
function checkWinCondition(room) {
  const alivePlayers = Array.from(room.players.values()).filter(p => p.alive);
  const aliveImpostors = alivePlayers.filter(p => p.role === 'impostor').length;
  const aliveCrewmates = alivePlayers.filter(p => p.role === 'crewmate').length;
  
  // Impostors win if they equal or outnumber crewmates
  if (aliveImpostors >= aliveCrewmates && aliveImpostors > 0) {
    return 'impostor';
  }
  
  // Crewmates win if all impostors dead
  if (aliveImpostors === 0) {
    return 'crewmate';
  }
  
  // Crewmates win if all tasks complete
  if (room.completedTasks >= room.totalTasks) {
    return 'crewmate';
  }
  
  return null;
}

// NEW: Helper function to find room by player ID
function findPlayerRoom(playerId) {
  for (const room of rooms.values()) {
    if (room.players.has(playerId)) {
      return room;
    }
  }
  return null;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Create room
  socket.on('createRoom', (playerName) => {
    const room = createRoom(socket.id, playerName);
    addPlayerToRoom(room, socket.id, playerName);
    socket.join(room.code);
    
    socket.emit('roomCreated', {
      code: room.code,
      isHost: true
    });
    
    io.to(room.code).emit('playersUpdate', {
      players: Array.from(room.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.id === room.hostId
      }))
    });
  });
  
  // Join room
  socket.on('joinRoom', ({ code, playerName }) => {
    const room = rooms.get(code);
    
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    
    if (room.state !== 'lobby') {
      socket.emit('error', 'Game already in progress');
      return;
    }
    
    if (room.players.size >= 10) {
      socket.emit('error', 'Room is full');
      return;
    }
    
    addPlayerToRoom(room, socket.id, playerName);
    socket.join(code);
    
    socket.emit('roomJoined', {
      code: room.code,
      isHost: socket.id === room.hostId
    });
    
    io.to(room.code).emit('playersUpdate', {
      players: Array.from(room.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.id === room.hostId
      }))
    });
  });
  
  // Start game
  socket.on('startGame', () => {
    // Find room where player is host
    let room = null;
    for (const [code, r] of rooms.entries()) {
      if (r.hostId === socket.id) {
        room = r;
        break;
      }
    }
    
    if (!room) return;
    
    if (room.players.size < 4) {
      socket.emit('error', 'Need at least 4 players to start');
      return;
    }
    
    startGame(room);
    
    // Send role to each player
    for (const [playerId, player] of room.players.entries()) {
      io.to(playerId).emit('gameStarted', {
        role: player.role,
        tasks: player.role === 'crewmate' ? player.tasks : [],
        // NEW: Send map data to clients
        mapWalls: MAP_WALLS,
        mapRooms: MAP_ROOMS
      });
    }
    
    // Send initial game state
    io.to(room.code).emit('gameState', {
      state: room.state,
      players: Array.from(room.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        alive: p.alive
      })),
      bodies: room.bodies,
      totalTasks: room.totalTasks,
      completedTasks: room.completedTasks
    });
  });
  
  // Player movement - UPDATED with server-side collision detection
  socket.on('move', ({ x, y }) => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (player && room.state === 'playing' && player.alive) {
        // Server validates position against walls
        let newX = Math.max(0, Math.min(MAP_WIDTH, x));
        let newY = Math.max(0, Math.min(MAP_HEIGHT, y));
        
        // Check collision with walls
        const playerRadius = 20;
        let collided = false;
        
        for (const wall of MAP_WALLS) {
          // Check if player circle intersects with wall rectangle
          const closestX = Math.max(wall.x, Math.min(newX, wall.x + wall.width));
          const closestY = Math.max(wall.y, Math.min(newY, wall.y + wall.height));
          
          const distX = newX - closestX;
          const distY = newY - closestY;
          const distSq = distX * distX + distY * distY;
          
          if (distSq < playerRadius * playerRadius) {
            collided = true;
            break;
          }
        }
        
        // Only update position if no collision
        if (!collided) {
          player.x = newX;
          player.y = newY;
          
          // Broadcast position
          io.to(room.code).emit('playerMoved', {
            id: socket.id,
            x: player.x,
            y: player.y
          });
        }
        break;
      }
    }
  });
  
  // Complete task
  socket.on('completeTask', (taskIndex) => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (player && room.state === 'playing' && player.alive && player.role === 'crewmate') {
        if (taskIndex >= 0 && taskIndex < player.tasks.length) {
          const task = player.tasks[taskIndex];
          const distance = Math.sqrt(
            Math.pow(player.x - task.x, 2) + Math.pow(player.y - task.y, 2)
          );
          
          if (distance < 50) {
            player.completedTaskCount++;
            room.completedTasks++;
            
            io.to(room.code).emit('taskCompleted', {
              playerId: socket.id,
              taskIndex,
              totalTasks: room.totalTasks,
              completedTasks: room.completedTasks
            });
            
            // Check win condition
            const winner = checkWinCondition(room);
            if (winner) {
              room.state = 'ended';
              io.to(room.code).emit('gameEnded', { winner });
            }
          }
        }
        break;
      }
    }
  });
  
  // Kill player
  socket.on('kill', (targetId) => {
    for (const room of rooms.values()) {
      const killer = room.players.get(socket.id);
      const target = room.players.get(targetId);
      
      if (!killer || !target || room.state !== 'playing') continue;
      if (killer.role !== 'impostor' || !killer.alive || !target.alive) continue;
      
      // Check cooldown
      const lastKill = room.killCooldowns.get(socket.id) || 0;
      if (Date.now() - lastKill < KILL_COOLDOWN) {
        socket.emit('error', 'Kill on cooldown');
        continue;
      }
      
      // Check proximity
      const distance = Math.sqrt(
        Math.pow(killer.x - target.x, 2) + Math.pow(killer.y - target.y, 2)
      );
      
      if (distance < 50) {
        target.alive = false;
        room.deadPlayers.add(targetId);
        room.bodies.push({
          x: target.x,
          y: target.y,
          name: target.name
        });
        room.killCooldowns.set(socket.id, Date.now());
        
        io.to(room.code).emit('playerKilled', {
          victimId: targetId,
          body: { x: target.x, y: target.y, name: target.name }
        });
        
        // Check win condition
        const winner = checkWinCondition(room);
        if (winner) {
          room.state = 'ended';
          io.to(room.code).emit('gameEnded', { winner });
        }
      }
      break;
    }
  });
  
  // Report body
  socket.on('reportBody', () => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (!player || room.state !== 'playing' || !player.alive) continue;
      
      // Check if near any body
      let foundBody = false;
      for (const body of room.bodies) {
        const distance = Math.sqrt(
          Math.pow(player.x - body.x, 2) + Math.pow(player.y - body.y, 2)
        );
        if (distance < 50) {
          foundBody = true;
          break;
        }
      }
      
      if (foundBody) {
        room.state = 'meeting';
        room.meetingCaller = socket.id;
        room.votes.clear();
        room.votingEndTime = Date.now() + VOTING_TIME;
        room.chatMessages = []; // NEW: Clear previous chat
        
        io.to(room.code).emit('meetingCalled', {
          caller: player.name,
          reason: 'body',
          alivePlayers: Array.from(room.players.values())
            .filter(p => p.alive)
            .map(p => ({ id: p.id, name: p.name })),
          votingTime: VOTING_TIME
        });
      }
      break;
    }
  });
  
  // Emergency meeting
  socket.on('emergencyMeeting', () => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (!player || room.state !== 'playing' || !player.alive) continue;
      
      room.state = 'meeting';
      room.meetingCaller = socket.id;
      room.votes.clear();
      room.votingEndTime = Date.now() + VOTING_TIME;
      room.chatMessages = []; // NEW: Clear previous chat
      
      io.to(room.code).emit('meetingCalled', {
        caller: player.name,
        reason: 'emergency',
        alivePlayers: Array.from(room.players.values())
          .filter(p => p.alive)
          .map(p => ({ id: p.id, name: p.name })),
        votingTime: VOTING_TIME
      });
      break;
    }
  });
  
  // NEW: Chat message during meeting
  socket.on('chatMessage', ({ message }) => {
    const room = findPlayerRoom(socket.id);
    if (!room) return;
    
    // Only allow chat during meeting
    if (room.state !== 'meeting') {
      socket.emit('error', 'Chat only available during meetings');
      return;
    }
    
    const player = room.players.get(socket.id);
    if (!player || !player.alive) {
      socket.emit('error', 'Dead players cannot chat');
      return;
    }
    
    // Validate message
    const cleanMessage = message.trim().substring(0, 200);
    if (!cleanMessage) return;
    
    const chatMsg = {
      sender: player.name,
      senderId: socket.id,
      message: cleanMessage,
      timestamp: Date.now()
    };
    
    room.chatMessages.push(chatMsg);
    
    // Broadcast to all players in room
    io.to(room.code).emit('chatUpdate', chatMsg);
  });
  
  // Vote
  socket.on('vote', (targetId) => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (!player || room.state !== 'meeting' || !player.alive) continue;
      
      room.votes.set(socket.id, targetId);
      
      io.to(room.code).emit('voteUpdate', {
        voterId: socket.id,
        voterName: player.name
      });
      
      // Check if all alive players voted
      const alivePlayers = Array.from(room.players.values()).filter(p => p.alive);
      if (room.votes.size === alivePlayers.length) {
        processVotes(room);
      }
      break;
    }
  });
  
  // Process votes
  function processVotes(room) {
    const voteCounts = new Map();
    
    for (const targetId of room.votes.values()) {
      voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
    }
    
    // Find player with most votes
    let maxVotes = 0;
    let ejectedId = null;
    let tie = false;
    
    for (const [targetId, count] of voteCounts.entries()) {
      if (count > maxVotes) {
        maxVotes = count;
        ejectedId = targetId;
        tie = false;
      } else if (count === maxVotes && count > 0) {
        tie = true;
      }
    }
    
    let ejectedPlayer = null;
    if (!tie && ejectedId && ejectedId !== 'skip') {
      ejectedPlayer = room.players.get(ejectedId);
      if (ejectedPlayer) {
        ejectedPlayer.alive = false;
        room.deadPlayers.add(ejectedId);
      }
    }
    
    room.state = 'playing';
    room.bodies = [];
    room.chatMessages = []; // NEW: Clear chat when meeting ends
    
    io.to(room.code).emit('votingComplete', {
      ejected: ejectedPlayer ? {
        name: ejectedPlayer.name,
        role: ejectedPlayer.role
      } : null,
      tie,
      votes: Object.fromEntries(room.votes)
    });
    
    // Check win condition
    const winner = checkWinCondition(room);
    if (winner) {
      room.state = 'ended';
      io.to(room.code).emit('gameEnded', { winner });
    } else {
      // Resume game
      setTimeout(() => {
        io.to(room.code).emit('gameState', {
          state: room.state,
          players: Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            x: p.x,
            y: p.y,
            alive: p.alive
          })),
          bodies: room.bodies,
          totalTasks: room.totalTasks,
          completedTasks: room.completedTasks
        });
      }, 5000);
    }
  }
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    for (const [code, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        
        // If host left, assign new host
        if (room.hostId === socket.id && room.players.size > 0) {
          room.hostId = Array.from(room.players.keys())[0];
        }
        
        // Delete room if empty
        if (room.players.size === 0) {
          rooms.delete(code);
        } else {
          io.to(room.code).emit('playersUpdate', {
            players: Array.from(room.players.values()).map(p => ({
              id: p.id,
              name: p.name,
              isHost: p.id === room.hostId
            }))
          });
          
          // If in game, check win condition
          if (room.state === 'playing') {
            const winner = checkWinCondition(room);
            if (winner) {
              room.state = 'ended';
              io.to(room.code).emit('gameEnded', { winner });
            }
          }
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});