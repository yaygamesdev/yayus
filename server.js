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
const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;

// Task locations
const TASK_LOCATIONS = [
  { x: 100, y: 100, name: 'Download Data' },
  { x: 700, y: 100, name: 'Fix Wiring' },
  { x: 400, y: 300, name: 'Empty Trash' },
  { x: 100, y: 500, name: 'Fuel Engines' },
  { x: 700, y: 500, name: 'Calibrate' },
  { x: 400, y: 100, name: 'Upload Data' },
  { x: 200, y: 300, name: 'Swipe Card' },
  { x: 600, y: 300, name: 'Inspect Sample' }
];

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
    killCooldowns: new Map()
  };
  
  rooms.set(code, room);
  return room;
}

// Add player to room
function addPlayerToRoom(room, socketId, name) {
  const player = {
    id: socketId,
    name,
    x: Math.random() * (MAP_WIDTH - 100) + 50,
    y: Math.random() * (MAP_HEIGHT - 100) + 50,
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
    
    // Reset position
    player.x = Math.random() * (MAP_WIDTH - 100) + 50;
    player.y = Math.random() * (MAP_HEIGHT - 100) + 50;
  }
  
  room.state = 'playing';
  room.deadPlayers.clear();
  room.bodies = [];
  room.totalTasks = (playerCount - impostorCount) * TASKS_PER_PLAYER;
  room.completedTasks = 0;
  room.killCooldowns.clear();
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
        tasks: player.role === 'crewmate' ? player.tasks : []
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
  
  // Player movement
  socket.on('move', ({ x, y }) => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (player && room.state === 'playing' && player.alive) {
        player.x = Math.max(0, Math.min(MAP_WIDTH, x));
        player.y = Math.max(0, Math.min(MAP_HEIGHT, y));
        
        // Broadcast position
        io.to(room.code).emit('playerMoved', {
          id: socket.id,
          x: player.x,
          y: player.y
        });
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