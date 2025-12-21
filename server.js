const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// Game state
let players = {};
let gameState = 'playing'; // 'playing', 'meeting', 'gameOver'
let votes = {};
let imposterCount = 0;
let crewmateCount = 0;

// Task locations (3 fixed rectangles)
const tasks = [
  { x: 100, y: 100, width: 60, height: 60 },
  { x: 500, y: 300, width: 60, height: 60 },
  { x: 300, y: 500, width: 60, height: 60 }
];

// Colors for players
const colors = ['#3498db', '#e74c3c', '#f39c12', '#9b59b6', '#1abc9c', '#34495e'];
let colorIndex = 0;

function assignRole() {
  const playerCount = Object.keys(players).length;
  // 1 imposter for every 4 players (minimum 1 imposter if 2+ players)
  const imposterTarget = Math.max(1, Math.floor(playerCount / 4));
  
  if (imposterCount < imposterTarget) {
    return 'Imposter';
  }
  return 'Crewmate';
}

function checkWinCondition() {
  const alivePlayers = Object.values(players).filter(p => !p.isDead);
  const aliveImposters = alivePlayers.filter(p => p.role === 'Imposter').length;
  const aliveCrewmates = alivePlayers.filter(p => p.role === 'Crewmate').length;
  
  if (aliveImposters === 0 && Object.keys(players).length > 1) {
    gameState = 'gameOver';
    return 'Crewmates';
  }
  if (aliveImposters >= aliveCrewmates && aliveCrewmates > 0) {
    gameState = 'gameOver';
    return 'Imposters';
  }
  return null;
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  
  // Initialize player
  const role = assignRole();
  if (role === 'Imposter') imposterCount++;
  else crewmateCount++;
  
  players[socket.id] = {
    id: socket.id,
    x: 400 + Math.random() * 100,
    y: 300 + Math.random() * 100,
    color: colors[colorIndex % colors.length],
    role: role,
    isDead: false,
    tasksCompleted: 0
  };
  colorIndex++;
  
  // Send initial data to the connected player
  socket.emit('init', {
    id: socket.id,
    role: role,
    tasks: tasks
  });
  
  // Handle movement
  socket.on('movement', (data) => {
    if (players[socket.id] && !players[socket.id].isDead && gameState === 'playing') {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
    }
  });
  
  // Handle kill attempt
  socket.on('kill', (targetId) => {
    const killer = players[socket.id];
    const target = players[targetId];
    
    if (!killer || !target || killer.isDead || target.isDead) return;
    if (killer.role !== 'Imposter') return;
    if (gameState !== 'playing') return;
    
    // Check distance
    const dx = killer.x - target.x;
    const dy = killer.y - target.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    if (distance < 50) {
      target.isDead = true;
      io.emit('playerKilled', targetId);
      
      const winner = checkWinCondition();
      if (winner) {
        io.emit('gameOver', winner);
      }
    }
  });
  
  // Handle report (start meeting)
  socket.on('report', () => {
    if (gameState === 'playing') {
      gameState = 'meeting';
      votes = {};
      io.emit('meetingStarted');
      
      // Auto-end meeting after 30 seconds
      setTimeout(() => {
        if (gameState === 'meeting') {
          endMeeting();
        }
      }, 30000);
    }
  });
  
  // Handle vote
  socket.on('vote', (targetId) => {
    if (gameState === 'meeting' && players[socket.id] && !players[socket.id].isDead) {
      votes[socket.id] = targetId;
      
      // Check if all alive players voted
      const alivePlayers = Object.values(players).filter(p => !p.isDead);
      if (Object.keys(votes).length >= alivePlayers.length) {
        endMeeting();
      }
    }
  });
  
  // Handle task completion
  socket.on('taskComplete', () => {
    if (players[socket.id] && players[socket.id].role === 'Crewmate') {
      players[socket.id].tasksCompleted++;
      
      // Check if all crewmates completed all tasks
      const crewmates = Object.values(players).filter(p => p.role === 'Crewmate' && !p.isDead);
      const allTasksComplete = crewmates.every(p => p.tasksCompleted >= 3);
      
      if (allTasksComplete && crewmates.length > 0) {
        gameState = 'gameOver';
        io.emit('gameOver', 'Crewmates');
      }
    }
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    if (players[socket.id]) {
      if (players[socket.id].role === 'Imposter') imposterCount--;
      else crewmateCount--;
      delete players[socket.id];
      
      const winner = checkWinCondition();
      if (winner) {
        io.emit('gameOver', winner);
      }
    }
  });
});

function endMeeting() {
  // Count votes
  const voteCounts = {};
  Object.values(votes).forEach(targetId => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });
  
  // Find player with most votes
  let maxVotes = 0;
  let ejectedId = null;
  Object.entries(voteCounts).forEach(([id, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      ejectedId = id;
    }
  });
  
  // Eject player if they got majority
  if (ejectedId && players[ejectedId]) {
    players[ejectedId].isDead = true;
    io.emit('playerEjected', {
      id: ejectedId,
      role: players[ejectedId].role
    });
  }
  
  gameState = 'playing';
  votes = {};
  io.emit('meetingEnded');
  
  const winner = checkWinCondition();
  if (winner) {
    io.emit('gameOver', winner);
  }
}

// Broadcast game state at 30 FPS
setInterval(() => {
  io.emit('gameState', {
    players: players,
    state: gameState
  });
}, 1000 / 30);

http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
