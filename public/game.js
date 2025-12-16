// Socket connection
const socket = io();

// Game state
let gameState = {
    roomCode: null,
    isHost: false,
    playerId: null,
    playerName: '',
    role: null,
    players: new Map(),
    myPlayer: null,
    tasks: [],
    completedTasks: new Set(),
    bodies: [],
    nearBody: false,
    nearTask: null,
    currentScreen: 'menu',
    // NEW: Map data
    mapWalls: [],
    mapRooms: [],
    currentRoom: null
};

// Canvas
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Input handling
const keys = {};
let lastMoveTime = 0;
const MOVE_INTERVAL = 50; // ms between position updates

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    setupSocketListeners();
});

// Setup keyboard listeners
function setupEventListeners() {
    document.addEventListener('keydown', (e) => {
        keys[e.key.toLowerCase()] = true;
        
        // Space for task completion
        if (e.key === ' ' && gameState.nearTask !== null) {
            completeTask(gameState.nearTask);
            e.preventDefault();
        }
    });
    
    document.addEventListener('keyup', (e) => {
        keys[e.key.toLowerCase()] = false;
    });
}

// Setup socket listeners
function setupSocketListeners() {
    socket.on('roomCreated', ({ code, isHost }) => {
        gameState.roomCode = code;
        gameState.isHost = isHost;
        showScreen('lobby');
        document.getElementById('lobbyRoomCode').textContent = code;
        
        if (isHost) {
            document.getElementById('startButton').style.display = 'block';
        }
    });
    
    socket.on('roomJoined', ({ code, isHost }) => {
        gameState.roomCode = code;
        gameState.isHost = isHost;
        showScreen('lobby');
        document.getElementById('lobbyRoomCode').textContent = code;
        
        if (isHost) {
            document.getElementById('startButton').style.display = 'block';
        }
    });
    
    socket.on('playersUpdate', ({ players }) => {
        const list = document.getElementById('playersList');
        list.innerHTML = '';
        
        players.forEach(player => {
            const div = document.createElement('div');
            div.className = 'player-item';
            div.innerHTML = `
                <span>${player.name}</span>
                ${player.isHost ? '<span class="host-badge">HOST</span>' : ''}
            `;
            list.appendChild(div);
        });
        
        document.getElementById('playerCount').textContent = players.length;
    });
    
    socket.on('gameStarted', ({ role, tasks, mapWalls, mapRooms }) => {
        gameState.role = role;
        gameState.tasks = tasks || [];
        gameState.completedTasks.clear();
        // NEW: Store map data
        gameState.mapWalls = mapWalls;
        gameState.mapRooms = mapRooms;
        
        showScreen('game');
        
        // Update role display
        const roleDisplay = document.getElementById('roleDisplay');
        roleDisplay.textContent = role === 'impostor' ? 'IMPOSTOR' : 'CREWMATE';
        roleDisplay.className = role === 'impostor' ? 'role-impostor' : 'role-crewmate';
        
        // Show/hide UI elements based on role
        if (role === 'impostor') {
            document.getElementById('killButton').style.display = 'block';
            document.getElementById('taskProgress').style.display = 'none';
        } else {
            document.getElementById('killButton').style.display = 'none';
            document.getElementById('taskProgress').style.display = 'block';
            updateTaskDisplay();
        }
        
        startGameLoop();
    });
    
    socket.on('gameState', ({ state, players, bodies, totalTasks, completedTasks }) => {
        gameState.players.clear();
        players.forEach(p => {
            gameState.players.set(p.id, p);
            if (p.id === socket.id) {
                gameState.myPlayer = p;
            }
        });
        
        gameState.bodies = bodies;
        
        if (gameState.role === 'crewmate') {
            document.getElementById('taskCount').textContent = 
                `${completedTasks}/${totalTasks}`;
            const progress = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
            document.getElementById('taskBar').style.width = progress + '%';
        }
        
        renderGame();
    });
    
    socket.on('playerMoved', ({ id, x, y }) => {
        const player = gameState.players.get(id);
        if (player) {
            player.x = x;
            player.y = y;
        }
    });
    
    socket.on('playerKilled', ({ victimId, body }) => {
        const player = gameState.players.get(victimId);
        if (player) {
            player.alive = false;
        }
        gameState.bodies.push(body);
    });
    
    socket.on('taskCompleted', ({ playerId, taskIndex, totalTasks, completedTasks }) => {
        if (playerId === socket.id) {
            gameState.completedTasks.add(taskIndex);
            updateTaskDisplay();
            closeTaskModal();
        }
        
        if (gameState.role === 'crewmate') {
            document.getElementById('taskCount').textContent = 
                `${completedTasks}/${totalTasks}`;
            const progress = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;
            document.getElementById('taskBar').style.width = progress + '%';
        }
    });
    
    socket.on('meetingCalled', ({ caller, reason, alivePlayers, votingTime }) => {
        showScreen('meeting');
        
        const info = document.getElementById('meetingInfo');
        info.innerHTML = `
            <h2>${reason === 'body' ? '☠️ Body Reported' : '🚨 Emergency Meeting'}</h2>
            <p>Called by: ${caller}</p>
            <p>Time to vote: ${votingTime / 1000}s</p>
        `;
        
        // NEW: Clear and show chat box
        const chatBox = document.getElementById('chatBox');
        chatBox.innerHTML = '';
        document.getElementById('chatInput').value = '';
        document.getElementById('chatInput').disabled = false;
        
        const votingList = document.getElementById('votingList');
        votingList.innerHTML = '';
        
        // Add skip option
        const skipDiv = document.createElement('div');
        skipDiv.className = 'vote-option';
        skipDiv.textContent = 'Skip Vote';
        skipDiv.onclick = () => vote('skip', skipDiv);
        votingList.appendChild(skipDiv);
        
        // Add player options
        alivePlayers.forEach(player => {
            const div = document.createElement('div');
            div.className = 'vote-option';
            div.textContent = player.name;
            div.onclick = () => vote(player.id, div);
            votingList.appendChild(div);
        });
    });
    
    socket.on('voteUpdate', ({ voterName }) => {
        showToast(`${voterName} voted`);
    });
    
    socket.on('votingComplete', ({ ejected, tie, votes }) => {
        const results = document.getElementById('votingResults');
        results.style.display = 'block';
        
        // NEW: Disable chat input after voting
        document.getElementById('chatInput').disabled = true;
        
        if (tie) {
            results.innerHTML = '<h2>No one was ejected (Tie)</h2>';
        } else if (ejected) {
            results.innerHTML = `
                <h2>${ejected.name} was ejected</h2>
                <p>${ejected.name} was ${ejected.role === 'impostor' ? 'an Impostor' : 'not an Impostor'}</p>
            `;
        } else {
            results.innerHTML = '<h2>No one was ejected</h2>';
        }
        
        // Return to game after 5 seconds
        setTimeout(() => {
            showScreen('game');
            results.style.display = 'none';
        }, 5000);
    });
    
    socket.on('gameEnded', ({ winner }) => {
        showScreen('gameOver');
        
        const winnerText = document.getElementById('winnerText');
        const stats = document.getElementById('finalStats');
        
        if (winner === 'impostor') {
            winnerText.textContent = '☠️ Impostors Win!';
            winnerText.style.color = '#f44336';
        } else {
            winnerText.textContent = '✅ Crewmates Win!';
            winnerText.style.color = '#4CAF50';
        }
        
        const myRole = gameState.role;
        const didWin = (winner === 'impostor' && myRole === 'impostor') || 
                       (winner === 'crewmate' && myRole === 'crewmate');
        
        stats.innerHTML = `
            <p>Your Role: ${myRole === 'impostor' ? 'Impostor' : 'Crewmate'}</p>
            <p>Result: ${didWin ? 'Victory!' : 'Defeat'}</p>
        `;
    });
    
    socket.on('error', (message) => {
        showToast(message);
    });
    
    // NEW: Listen for chat updates
    socket.on('chatUpdate', (chatMsg) => {
        addChatMessage(chatMsg);
    });
}

// Menu functions
function showCreateJoin() {
    const name = document.getElementById('playerName').value.trim();
    if (!name) {
        showToast('Please enter your name');
        return;
    }
    
    gameState.playerName = name;
    document.getElementById('initial-menu').style.display = 'none';
    document.getElementById('create-join-menu').style.display = 'block';
}

function backToInitial() {
    document.getElementById('create-join-menu').style.display = 'none';
    document.getElementById('initial-menu').style.display = 'block';
}

function showJoinRoom() {
    document.getElementById('create-join-menu').style.display = 'none';
    document.getElementById('join-room-menu').style.display = 'block';
}

function backToCreateJoin() {
    document.getElementById('join-room-menu').style.display = 'none';
    document.getElementById('create-join-menu').style.display = 'block';
}

function createRoom() {
    socket.emit('createRoom', gameState.playerName);
}

function joinRoom() {
    const code = document.getElementById('roomCode').value.trim();
    if (code.length !== 6) {
        showToast('Room code must be 6 digits');
        return;
    }
    
    socket.emit('joinRoom', {
        code,
        playerName: gameState.playerName
    });
}

function leaveRoom() {
    location.reload();
}

function startGame() {
    socket.emit('startGame');
}

function returnToMenu() {
    location.reload();
}

// Game functions
function startGameLoop() {
    gameState.playerId = socket.id;
    requestAnimationFrame(gameLoop);
}

function gameLoop() {
    if (gameState.currentScreen !== 'game') return;
    
    handleMovement();
    checkProximity();
    updateCurrentRoom(); // NEW: Update current room display
    renderGame();
    
    requestAnimationFrame(gameLoop);
}

function handleMovement() {
    if (!gameState.myPlayer || !gameState.myPlayer.alive) return;
    
    const now = Date.now();
    if (now - lastMoveTime < MOVE_INTERVAL) return;
    
    let dx = 0;
    let dy = 0;
    const speed = 5;
    
    if (keys['w'] || keys['arrowup']) dy -= speed;
    if (keys['s'] || keys['arrowdown']) dy += speed;
    if (keys['a'] || keys['arrowleft']) dx -= speed;
    if (keys['d'] || keys['arrowright']) dx += speed;
    
    if (dx !== 0 || dy !== 0) {
        // NEW: Client-side collision prediction
        let newX = gameState.myPlayer.x + dx;
        let newY = gameState.myPlayer.y + dy;
        
        // Check collision locally
        const playerRadius = 20;
        let collided = false;
        
        for (const wall of gameState.mapWalls) {
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
        
        if (!collided) {
            gameState.myPlayer.x = newX;
            gameState.myPlayer.y = newY;
            
            socket.emit('move', {
                x: gameState.myPlayer.x,
                y: gameState.myPlayer.y
            });
        }
        
        lastMoveTime = now;
    }
}

function checkProximity() {
    if (!gameState.myPlayer || !gameState.myPlayer.alive) return;
    
    const px = gameState.myPlayer.x;
    const py = gameState.myPlayer.y;
    
    // Check proximity to bodies
    let nearBody = false;
    for (const body of gameState.bodies) {
        const dist = Math.sqrt(Math.pow(px - body.x, 2) + Math.pow(py - body.y, 2));
        if (dist < 50) {
            nearBody = true;
            break;
        }
    }
    
    gameState.nearBody = nearBody;
    document.getElementById('reportButton').style.display = nearBody ? 'block' : 'none';
    
    // Check proximity to tasks (crewmates only)
    if (gameState.role === 'crewmate') {
        let nearTask = null;
        for (let i = 0; i < gameState.tasks.length; i++) {
            if (gameState.completedTasks.has(i)) continue;
            
            const task = gameState.tasks[i];
            const dist = Math.sqrt(Math.pow(px - task.x, 2) + Math.pow(py - task.y, 2));
            if (dist < 50) {
                nearTask = i;
                break;
            }
        }
        
        if (nearTask !== null && gameState.nearTask !== nearTask) {
            showTaskModal(nearTask);
        } else if (nearTask === null && gameState.nearTask !== null) {
            closeTaskModal();
        }
        
        gameState.nearTask = nearTask;
    }
}

function renderGame() {
    // Clear canvas
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // NEW: Draw map rooms (floor)
    ctx.fillStyle = '#2d2d44';
    for (const room of gameState.mapRooms) {
        ctx.fillRect(room.x, room.y, room.width, room.height);
    }
    
    // NEW: Draw room labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'center';
    for (const room of gameState.mapRooms) {
        ctx.fillText(room.name, room.x + room.width / 2, room.y + room.height / 2);
    }
    
    // NEW: Draw walls
    ctx.fillStyle = '#0f0f1e';
    for (const wall of gameState.mapWalls) {
        ctx.fillRect(wall.x, wall.y, wall.width, wall.height);
    }
    
    // Draw tasks (crewmates only)
    if (gameState.role === 'crewmate') {
        gameState.tasks.forEach((task, i) => {
            const completed = gameState.completedTasks.has(i);
            ctx.fillStyle = completed ? '#4CAF50' : '#FFC107';
            ctx.beginPath();
            ctx.arc(task.x, task.y, 15, 0, Math.PI * 2);
            ctx.fill();
            
            // Task name
            ctx.fillStyle = '#fff';
            ctx.font = '12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(task.name, task.x, task.y - 20);
        });
    }
    
    // Draw bodies
    gameState.bodies.forEach(body => {
        ctx.fillStyle = '#666';
        ctx.beginPath();
        ctx.arc(body.x, body.y, 15, 0, Math.PI * 2);
        ctx.fill();
        
        // X mark
        ctx.strokeStyle = '#f44336';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(body.x - 10, body.y - 10);
        ctx.lineTo(body.x + 10, body.y + 10);
        ctx.moveTo(body.x + 10, body.y - 10);
        ctx.lineTo(body.x - 10, body.y + 10);
        ctx.stroke();
    });
    
    // Draw players
    gameState.players.forEach(player => {
        if (!player.alive && gameState.myPlayer && !gameState.myPlayer.alive) {
            // Show dead players to dead players
            ctx.globalAlpha = 0.5;
        }
        
        // Player circle
        if (player.id === socket.id) {
            ctx.fillStyle = gameState.role === 'impostor' ? '#f44336' : '#2196F3';
        } else {
            ctx.fillStyle = player.alive ? '#4CAF50' : '#666';
        }
        
        ctx.beginPath();
        ctx.arc(player.x, player.y, 20, 0, Math.PI * 2);
        ctx.fill();
        
        // Player name
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(player.name, player.x, player.y + 35);
        
        ctx.globalAlpha = 1;
    });
}

function completeTask(taskIndex) {
    socket.emit('completeTask', taskIndex);
}

function attemptKill() {
    if (gameState.role !== 'impostor' || !gameState.myPlayer || !gameState.myPlayer.alive) return;
    
    // Find nearest alive player
    let nearest = null;
    let minDist = Infinity;
    
    gameState.players.forEach(player => {
        if (player.id === socket.id || !player.alive) return;
        
        const dist = Math.sqrt(
            Math.pow(gameState.myPlayer.x - player.x, 2) +
            Math.pow(gameState.myPlayer.y - player.y, 2)
        );
        
        if (dist < minDist && dist < 50) {
            minDist = dist;
            nearest = player;
        }
    });
    
    if (nearest) {
        socket.emit('kill', nearest.id);
    }
}

function reportBody() {
    socket.emit('reportBody');
}

function emergencyMeeting() {
    socket.emit('emergencyMeeting');
}

function vote(targetId, element) {
    // Clear previous selection
    document.querySelectorAll('.vote-option').forEach(el => {
        el.classList.remove('selected');
    });
    
    element.classList.add('selected');
    socket.emit('vote', targetId);
}

// NEW: Chat functions
function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    
    if (!message) return;
    
    socket.emit('chatMessage', { message });
    input.value = '';
}

function addChatMessage(chatMsg) {
    const chatBox = document.getElementById('chatBox');
    
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-message';
    msgDiv.innerHTML = `
        <span class="sender">${chatMsg.sender}:</span>
        <span class="message-text">${escapeHtml(chatMsg.message)}</span>
    `;
    
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight; // Auto-scroll to bottom
}

// Helper to escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Allow Enter key to send chat
document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendChatMessage();
            }
        });
    }
});

// UI functions
function showScreen(screen) {
    document.querySelectorAll('.screen').forEach(s => {
        s.classList.remove('active');
    });
    document.getElementById(screen).classList.add('active');
    gameState.currentScreen = screen;
}

function showTaskModal(taskIndex) {
    const task = gameState.tasks[taskIndex];
    document.getElementById('taskTitle').textContent = task.name;
    document.getElementById('taskModal').classList.add('active');
}

function closeTaskModal() {
    document.getElementById('taskModal').classList.remove('active');
}

function updateTaskDisplay() {
    const completed = gameState.completedTasks.size;
    const total = gameState.tasks.length;
    // Local task progress for this player
    const personalProgress = document.getElementById('taskProgress');
    if (personalProgress) {
        const count = personalProgress.querySelector('#taskCount');
        if (count && !count.textContent.includes('/')) {
            // Only update if it's our personal counter
        }
    }
}

function showToast(message) {
    const toast = document.getElementById('errorToast');
    toast.textContent = message;
    toast.classList.add('active');
    
    setTimeout(() => {
        toast.classList.remove('active');
    }, 3000);
}