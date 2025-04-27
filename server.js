const express = require('express');
const http = require('http');
const app = express();
const { Server } = require('socket.io');
const path = require('path');
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

let rooms = {};

const wordPairs = require('./wordpairs.json');

// Track used pairs per room
const usedWordPairs = {};

function getRandomWordPair(roomId) {
  // Filter out used pairs for this room
  const availablePairs = wordPairs.filter(pair =>
    !usedWordPairs[roomId]?.includes(JSON.stringify(pair))
  );

  if (availablePairs.length === 0) {
    // Reset if all pairs used
    usedWordPairs[roomId] = [];
    return wordPairs[Math.floor(Math.random() * wordPairs.length)];
  }

  const selectedPair = availablePairs[Math.floor(Math.random() * availablePairs.length)];

  // Track used pairs
  if (!usedWordPairs[roomId]) usedWordPairs[roomId] = [];
  usedWordPairs[roomId].push(JSON.stringify(selectedPair));

  return selectedPair;
}

function assignWords(room) {
  // 🔁 Only assign if it's not already set (e.g., at game start)
  if (!room.wordPair) {
    room.wordPair = getRandomWordPair(room.id); // Pass room ID
  }

  const alivePlayers = room.players;
  const spyIndex = Math.floor(Math.random() * alivePlayers.length);

  alivePlayers.forEach((player, index) => {
    player.isSpy = index === spyIndex;
    io.to(player.id).emit('wordAssigned', player.isSpy ? room.wordPair.spy : room.wordPair.common);
  });

  room.votes = []; // Reset votes for the round

  alivePlayers.forEach((player) => {
    io.to(player.id).emit('youAre', {
      isAlive: player.isAlive,
      id: player.id
    });
  });
}


io.on('connection', socket => {
  console.log(`User connected: ${socket.id}`);


  socket.on('createRoom', (roomId, playerName) => {
    const room = rooms[roomId];
    if (room && room.players.length > 0) {
      socket.emit('errorMessage', 'Room already exists and is active. Please join instead.');
      return;
    }

    rooms[roomId] = {
      players: [{
        id: socket.id,
        name: playerName,
        isSpy: false,
        isAlive: true,
        isHost: true  // Mark creator as host
      }],
      gameStarted: false,
    };
    socket.join(roomId);
    io.to(roomId).emit('roomUpdate', rooms[roomId]);
  });

  // In joinRoom handler:
  socket.on('joinRoom', (roomId, playerName) => {
    if (!rooms[roomId]) return;
    rooms[roomId].players.push({
      id: socket.id,
      name: playerName,
      isSpy: false,
      isAlive: true,
      isHost: false  // Joined players are not hosts
    });
    socket.join(roomId);
    io.to(roomId).emit('roomUpdate', rooms[roomId]);
  });

  // Remove the gameStarting emission from startGame handler
  socket.on('startGame', roomId => {
    const room = rooms[roomId];
    if (!room) return;

    // Verify the sender is the host
    const sender = room.players.find(p => p.id === socket.id);
    if (!sender || !sender.isHost) return;

    // Rest of your existing start game logic
    room.players.forEach(player => {
      player.isAlive = true;
      player.ready = false;
    });

    if (room.players.length < 3) {
      io.to(socket.id).emit('errorMessage', 'At least 3 players are required to start the game.');
      return;
    }

    room.wordPair = null;
    assignWords(room);
  });

  socket.on('vote', ({ roomId, votedId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.isAlive) return;

    room.votes.push({ voter: socket.id, votedId });

    // Check if all alive players have voted
    const aliveCount = room.players.filter(p => p.isAlive).length;
    if (room.votes.length >= aliveCount) {
      // Tally votes
      const tally = {};
      room.votes.forEach(v => {
        tally[v.votedId] = (tally[v.votedId] || 0) + 1;
      });

      // Find max vote count
      const maxVotes = Math.max(...Object.values(tally));
      const topVoted = Object.entries(tally)
        .filter(([_, count]) => count === maxVotes)
        .map(([id]) => id);

      let resultMessage;
      let eliminatedPlayer = null;

      // In the vote handler where elimination happens:
      if (topVoted.length === 1) {
        const eliminatedId = topVoted[0];
        eliminatedPlayer = room.players.find(p => p.id === eliminatedId);
        if (eliminatedPlayer) {
          eliminatedPlayer.isAlive = false;
          const spyStatus = eliminatedPlayer.isSpy ? "Spy was caught!" : "Not a spy!";
          resultMessage = `${eliminatedPlayer.name} was eliminated! ${spyStatus}`;
        }
      } else {
        resultMessage = `It's a tie! No one was eliminated.`;
      }

      const votingDetails = {
        votes: room.votes.map(vote => {
          const voter = room.players.find(p => p.id === vote.voter);
          let choice;
          if (vote.isSkip) {
            choice = "Skip";
          } else {
            const votedPlayer = room.players.find(p => p.id === vote.votedId);
            choice = votedPlayer ? votedPlayer.name : "Unknown";
          }
          return {
            voterName: voter.name,
            choice: choice
          };
        }),
        eliminationMessage: resultMessage // This contains the full message we were showing before
      };
      
      io.to(roomId).emit('votingResults', votingDetails);

      // Clear votes for next round
      room.votes = [];

      const alivePlayers = room.players.filter(p => p.isAlive);
      const spyAlive = alivePlayers.find(p => p.isSpy);

      // Check victory conditions
      if (!spyAlive) {
        // Spy was caught - team wins
        setTimeout(() => {
          io.to(roomId).emit('gameOver', 'Spy has been caught! Team wins!');
        }, 2000);
      } else if (alivePlayers.length <= 2) {
        // Spy wins by survival
        setTimeout(() => {
          io.to(roomId).emit('gameOver', 'Spy wins! Only 2 players remain!');
        }, 2000);
      } else {
        // Game continues - don't reset words
        setTimeout(() => {
          io.to(roomId).emit('nextRound');
        }, 3000);
      }
    }
  });

  socket.on('playerReady', roomId => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = true;

      // Only check players still connected (i.e., sockets that exist in io.sockets.sockets)
      const connectedPlayers = room.players.filter(p => io.sockets.sockets.get(p.id));
      const allReady = connectedPlayers.every(p => p.ready);

      if (allReady) {
        // Reset ready flags for connected players only
        connectedPlayers.forEach(p => p.ready = false);

        // Notify clients to begin next round
        io.to(roomId).emit('nextRound');
      } else {
        const notReady = connectedPlayers.filter(p => !p.ready).map(p => p.name);
        socket.emit('waitingForPlayers', notReady);
      }
    }
  });

  socket.on('requestPlayers', roomId => {
    const room = rooms[roomId];
    if (!room) return;
    const alivePlayers = room.players.filter(p => p.isAlive).map(p => ({
      id: p.id,
      name: p.name
    }));
    io.to(socket.id).emit('showVoteOptions', alivePlayers);
  });

  socket.on('verifyHost', (roomId, callback) => {
    const room = rooms[roomId];
    if (!room) return callback(false);

    const player = room.players.find(p => p.id === socket.id);
    callback(player ? player.isHost : false);
  });

  socket.on('restartGame', roomId => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.readyToRestart = true;
      player.ready = false; // Reset regular ready status
    }

    // Separate connected vs disconnected players
    const connectedPlayers = room.players.filter(p => io.sockets.sockets.get(p.id));
    const disconnectedPlayers = room.players.filter(p => !io.sockets.sockets.get(p.id));

    // Only consider connected players for restart
    const readyPlayers = connectedPlayers.filter(p => p.readyToRestart);
    const notReadyPlayers = connectedPlayers.filter(p => !p.readyToRestart);

    // Show waiting message only for connected AND not-ready players
    const waitingForNames = notReadyPlayers.map(p => p.name);
    io.to(roomId).emit('waitingForPlayers', waitingForNames);

    // When all connected players are ready
    if (readyPlayers.length === connectedPlayers.length) {
      // Reset all players (including disconnected ones)
      room.players.forEach(p => {
        p.isAlive = true;
        p.isSpy = false;
        p.ready = false;
        p.readyToRestart = false;
      });

      room.votes = [];
      room.wordPair = null;
      io.to(roomId).emit('gameRestarted', room.players);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    for (const roomId in rooms) {
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      io.to(roomId).emit('roomUpdate', rooms[roomId]);
    }
    for (const roomId in rooms) {
      if (rooms[roomId].players.some(p => p.readyToRestart)) {
        io.to(roomId).emit('waitingForPlayers',
          rooms[roomId].players
            .filter(p => io.sockets.sockets.get(p.id) && !p.readyToRestart)
            .map(p => p.name)
        );
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
