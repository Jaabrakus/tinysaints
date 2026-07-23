(() => {
  "use strict";

  const canvas = document.querySelector("#game");
  const context = canvas.getContext("2d");
  const flameBar = document.querySelector("#flameBar");
  const flameValue = document.querySelector("#flameValue");
  const tinderValue = document.querySelector("#tinderValue");
  const distanceValue = document.querySelector("#distanceValue");
  const statusText = document.querySelector("#statusText");
  const startCard = document.querySelector("#startCard");
  const startButton = document.querySelector("#startButton");
  const restartButton = document.querySelector("#restartButton");

  const WORLD = { width: 1200, height: 720 };
  const START = { x: 92, y: 360 };
  const GOAL = { x: 1110, y: 360, radius: 54 };
  const SAFE_SPEED = 132;
  const keys = new Set();
  const players = [
    { x: 126, y: 335, vx: 0, vy: 0, radius: 15, color: "#caff45", label: "1", controls: ["KeyA", "KeyD", "KeyW", "KeyS"], sprint: "ShiftLeft" },
    { x: 160, y: 390, vx: 0, vy: 0, radius: 15, color: "#9d8cff", label: "2", controls: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"], sprint: "Slash" },
  ];
  const rocks = [
    { x: 250, y: 95, w: 100, h: 210 }, { x: 250, y: 430, w: 100, h: 190 },
    { x: 470, y: 225, w: 130, h: 130 }, { x: 690, y: 70, w: 105, h: 230 },
    { x: 690, y: 425, w: 105, h: 230 }, { x: 900, y: 250, w: 100, h: 220 },
  ];
  const windZones = [
    { x: 360, y: 0, w: 90, h: 720, direction: 1 },
    { x: 815, y: 0, w: 70, h: 720, direction: -1 },
  ];
  const tinderSpawns = [
    [195, 130], [405, 585], [550, 115], [625, 560], [765, 355], [1018, 145], [1035, 570],
  ];

  let tinder = [];
  let embers = [];
  let holder = 0;
  let flame = 100;
  let reserve = 0;
  let running = false;
  let result = "waiting";
  let lastTime = 0;
  let passCooldown = 0;
  let resetTimer = 0;

  function resetGame(begin = true) {
    players[0].x = 126; players[0].y = 335; players[0].vx = 0; players[0].vy = 0;
    players[1].x = 160; players[1].y = 390; players[1].vx = 0; players[1].vy = 0;
    tinder = tinderSpawns.map(([x, y], index) => ({ x, y, radius: 10, taken: false, phase: index * 0.9 }));
    embers = [];
    holder = 0;
    flame = 100;
    reserve = 0;
    result = begin ? "playing" : "waiting";
    running = begin;
    resetTimer = 0;
    passCooldown = 0;
    lastTime = performance.now();
    startCard.classList.toggle("is-hidden", begin);
    statusText.textContent = begin ? "Player one carries the fire. Walk—do not sprint." : "The fire is waiting.";
    updateHud();
    if (begin) canvas.focus();
  }

  function isDown(code) { return keys.has(code); }

  function playerInput(player) {
    const [left, right, up, down] = player.controls;
    const x = Number(isDown(right)) - Number(isDown(left));
    const y = Number(isDown(down)) - Number(isDown(up));
    const length = Math.hypot(x, y) || 1;
    const sprinting = isDown(player.sprint);
    const speed = sprinting ? 245 : 124;
    return { x: x / length * speed, y: y / length * speed, sprinting };
  }

  function circleHitsRect(x, y, radius, rectangle) {
    const closestX = Math.max(rectangle.x, Math.min(x, rectangle.x + rectangle.w));
    const closestY = Math.max(rectangle.y, Math.min(y, rectangle.y + rectangle.h));
    return Math.hypot(x - closestX, y - closestY) < radius;
  }

  function movePlayer(player, delta) {
    const input = playerInput(player);
    const previousX = player.x;
    const previousY = player.y;
    player.vx = input.x;
    player.vy = input.y;
    player.x = Math.max(player.radius, Math.min(WORLD.width - player.radius, player.x + player.vx * delta));
    if (rocks.some((rock) => circleHitsRect(player.x, player.y, player.radius, rock))) player.x = previousX;
    player.y = Math.max(player.radius, Math.min(WORLD.height - player.radius, player.y + player.vy * delta));
    if (rocks.some((rock) => circleHitsRect(player.x, player.y, player.radius, rock))) player.y = previousY;
  }

  function inWind(player) {
    return windZones.some((zone) => circleHitsRect(player.x, player.y, player.radius, zone));
  }

  function passTorch() {
    if (!running || passCooldown > 0) return;
    if (Math.hypot(players[0].x - players[1].x, players[0].y - players[1].y) > 72) {
      statusText.textContent = "Move closer before passing the torch.";
      return;
    }
    holder = holder === 0 ? 1 : 0;
    passCooldown = 0.65;
    statusText.textContent = `Player ${holder + 1} carries the fire now.`;
  }

  function useTinder() {
    if (!running || reserve < 1 || flame >= 99) return;
    reserve -= 1;
    flame = Math.min(100, flame + 30);
    statusText.textContent = "Tinder catches. The flame steadies.";
    for (let index = 0; index < 18; index += 1) spawnEmber(players[holder], true);
  }

  function spawnEmber(player, burst = false) {
    embers.push({
      x: player.x + (Math.random() - 0.5) * 8,
      y: player.y - 18,
      vx: (Math.random() - 0.5) * (burst ? 80 : 24),
      vy: -20 - Math.random() * (burst ? 80 : 35),
      life: 0.35 + Math.random() * 0.55,
      maxLife: 0.9,
      size: 1 + Math.random() * 2.5,
    });
  }

  function update(delta) {
    if (!running) return;
    passCooldown = Math.max(0, passCooldown - delta);
    players.forEach((player) => movePlayer(player, delta));

    const carrier = players[holder];
    const companion = players[holder === 0 ? 1 : 0];
    const carrierSpeed = Math.hypot(carrier.vx, carrier.vy);
    const separation = Math.hypot(carrier.x - companion.x, carrier.y - companion.y);
    let drain = 0.6;
    if (carrierSpeed > SAFE_SPEED) drain += 8 + (carrierSpeed - SAFE_SPEED) * 0.14;
    if (inWind(carrier)) drain += 11;
    if (separation > 210) drain += 5;
    if (separation < 92) drain = Math.max(0.15, drain - 1.5);
    flame = Math.max(0, flame - drain * delta);

    for (const pickup of tinder) {
      if (pickup.taken) continue;
      const collector = players.find((player) => Math.hypot(player.x - pickup.x, player.y - pickup.y) < player.radius + pickup.radius + 4);
      if (collector) {
        pickup.taken = true;
        reserve += 1;
        statusText.textContent = `Player ${players.indexOf(collector) + 1} found tinder. Press E to feed the flame.`;
      }
    }

    if (Math.random() < delta * (flame < 35 ? 18 : 8)) spawnEmber(carrier);
    embers.forEach((ember) => {
      ember.x += ember.vx * delta;
      ember.y += ember.vy * delta;
      ember.life -= delta;
    });
    embers = embers.filter((ember) => ember.life > 0);

    if (flame <= 0) {
      running = false;
      result = "lost";
      resetTimer = 2.2;
      statusText.textContent = "The flame went dark. Returning to the first fire…";
    } else if (Math.hypot(carrier.x - GOAL.x, carrier.y - GOAL.y) < GOAL.radius) {
      running = false;
      result = "won";
      statusText.textContent = "A second bonfire lives. The path belongs to everyone now.";
    } else if (carrierSpeed > SAFE_SPEED) {
      statusText.textContent = "Too fast—the flame is tearing apart.";
    } else if (inWind(carrier)) {
      statusText.textContent = "Crosswind. Stay close and move carefully.";
    } else if (separation > 210) {
      statusText.textContent = "Too far apart. The carrier needs shelter.";
    }

    updateHud();
  }

  function updateHud() {
    const carrier = players[holder];
    const progress = Math.max(0, Math.min(100, (carrier.x - START.x) / (GOAL.x - START.x) * 100));
    flameBar.style.width = `${flame}%`;
    flameValue.textContent = `${Math.ceil(flame)}%`;
    tinderValue.textContent = String(reserve);
    distanceValue.textContent = `${Math.floor(progress)}%`;
  }

  function roundedRect(x, y, width, height, radius) {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
  }

  function drawGround(time) {
    context.fillStyle = "#172016";
    context.fillRect(0, 0, WORLD.width, WORLD.height);
    context.strokeStyle = "#263024";
    context.lineWidth = 1;
    for (let x = 0; x < WORLD.width; x += 48) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, WORLD.height); context.stroke();
    }
    for (let y = 0; y < WORLD.height; y += 48) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(WORLD.width, y); context.stroke();
    }
    for (const zone of windZones) {
      context.fillStyle = "#8fb0a20b";
      context.fillRect(zone.x, zone.y, zone.w, zone.h);
      context.fillStyle = "#a7c5b329";
      context.font = "16px ui-monospace, monospace";
      for (let y = 40; y < WORLD.height; y += 62) {
        const drift = Math.sin(time / 500 + y) * 8;
        context.fillText(zone.direction > 0 ? "→ →" : "← ←", zone.x + 20 + drift, y);
      }
    }
  }

  function drawBonfire(x, y, lit, label) {
    context.strokeStyle = "#695144";
    context.lineWidth = 7;
    context.beginPath(); context.moveTo(x - 22, y + 18); context.lineTo(x + 22, y - 10); context.stroke();
    context.beginPath(); context.moveTo(x - 22, y - 10); context.lineTo(x + 22, y + 18); context.stroke();
    if (lit) {
      const glow = context.createRadialGradient(x, y, 0, x, y, 62);
      glow.addColorStop(0, "#fff2aaae");
      glow.addColorStop(0.3, "#ff9b6190");
      glow.addColorStop(1, "#ff9b6100");
      context.fillStyle = glow;
      context.beginPath(); context.arc(x, y, 62, 0, Math.PI * 2); context.fill();
      context.fillStyle = "#ffb05f";
      context.beginPath(); context.moveTo(x, y - 34); context.quadraticCurveTo(x + 28, y, x, y + 19); context.quadraticCurveTo(x - 24, y - 2, x, y - 34); context.fill();
    }
    context.fillStyle = "#899080";
    context.font = "700 11px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText(label, x, y + 72);
  }

  function drawWorld(time) {
    drawGround(time);
    drawBonfire(START.x, START.y, true, "FIRST FIRE");
    drawBonfire(GOAL.x, GOAL.y, result === "won", "NEXT FIRE");

    for (const rock of rocks) {
      context.fillStyle = "#252b23";
      context.strokeStyle = "#353d32";
      context.lineWidth = 2;
      roundedRect(rock.x, rock.y, rock.w, rock.h, 22);
      context.fill(); context.stroke();
    }

    for (const pickup of tinder) {
      if (pickup.taken) continue;
      const pulse = 1 + Math.sin(time / 260 + pickup.phase) * 0.18;
      context.shadowColor = "#ff9b61";
      context.shadowBlur = 16;
      context.fillStyle = "#ffb06a";
      context.beginPath(); context.arc(pickup.x, pickup.y, pickup.radius * pulse, 0, Math.PI * 2); context.fill();
      context.shadowBlur = 0;
      context.fillStyle = "#8a5942";
      context.fillRect(pickup.x - 2, pickup.y - 16, 4, 10);
    }

    players.forEach((player, index) => {
      context.shadowColor = player.color;
      context.shadowBlur = index === holder ? 20 : 8;
      context.fillStyle = player.color;
      context.beginPath(); context.arc(player.x, player.y, player.radius, 0, Math.PI * 2); context.fill();
      context.shadowBlur = 0;
      context.fillStyle = "#0b0d09";
      context.font = "800 10px ui-monospace, monospace";
      context.textAlign = "center";
      context.fillText(player.label, player.x, player.y + 4);
    });

    const carrier = players[holder];
    const flameScale = 0.45 + flame / 100 * 0.75;
    context.fillStyle = "#f6df7b";
    context.beginPath();
    context.moveTo(carrier.x, carrier.y - 22 - 18 * flameScale);
    context.quadraticCurveTo(carrier.x + 13 * flameScale, carrier.y - 23, carrier.x, carrier.y - 13);
    context.quadraticCurveTo(carrier.x - 12 * flameScale, carrier.y - 25, carrier.x, carrier.y - 22 - 18 * flameScale);
    context.fill();
    context.strokeStyle = "#79523a";
    context.lineWidth = 4;
    context.beginPath(); context.moveTo(carrier.x, carrier.y - 15); context.lineTo(carrier.x, carrier.y + 4); context.stroke();

    for (const ember of embers) {
      context.globalAlpha = Math.max(0, ember.life / ember.maxLife);
      context.fillStyle = "#ffb05f";
      context.beginPath(); context.arc(ember.x, ember.y, ember.size, 0, Math.PI * 2); context.fill();
    }
    context.globalAlpha = 1;

    const lightRadius = 115 + flame * 1.35;
    const darkness = context.createRadialGradient(carrier.x, carrier.y, 28, carrier.x, carrier.y, lightRadius);
    darkness.addColorStop(0, "#02030200");
    darkness.addColorStop(0.55, "#02030228");
    darkness.addColorStop(1, "#020302e8");
    context.fillStyle = darkness;
    context.fillRect(0, 0, WORLD.width, WORLD.height);

    if (result === "won" || result === "lost") {
      context.fillStyle = "#070907c9";
      context.fillRect(0, 0, WORLD.width, WORLD.height);
      context.textAlign = "center";
      context.fillStyle = result === "won" ? "#caff45" : "#ff796b";
      context.font = "800 18px ui-monospace, monospace";
      context.fillText(result === "won" ? "THE FIRE ARRIVED" : "THE FLAME WENT DARK", WORLD.width / 2, 320);
      context.fillStyle = "#f1f2e9";
      context.font = "700 46px system-ui, sans-serif";
      context.fillText(result === "won" ? "Carry it farther." : "Stay closer. Move slower.", WORLD.width / 2, 375);
      context.fillStyle = "#969c90";
      context.font = "13px ui-monospace, monospace";
      context.fillText(result === "won" ? "Restart, then trade roles." : "The first fire will relight the torch.", WORLD.width / 2, 410);
    }
  }

  function frame(time) {
    const delta = Math.min(0.05, Math.max(0, (time - lastTime) / 1000));
    lastTime = time;
    if (resetTimer > 0) {
      resetTimer -= delta;
      if (resetTimer <= 0) resetGame(true);
    }
    update(delta);
    drawWorld(time);
    requestAnimationFrame(frame);
  }

  document.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(event.code)) event.preventDefault();
    keys.add(event.code);
    if (event.repeat) return;
    if (event.code === "KeyQ") passTorch();
    if (event.code === "KeyE" || event.code === "Enter") useTinder();
    if (event.code === "KeyR") resetGame(true);
  });
  document.addEventListener("keyup", (event) => keys.delete(event.code));
  document.addEventListener("visibilitychange", () => { if (document.hidden) keys.clear(); });

  document.querySelectorAll("[data-touch]").forEach((button) => {
    const code = button.dataset.touch;
    const press = (event) => { event.preventDefault(); keys.add(code); };
    const release = (event) => { event.preventDefault(); keys.delete(code); };
    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("pointerleave", release);
  });
  document.querySelector("[data-tap='pass']").addEventListener("click", passTorch);
  document.querySelector("[data-tap='fuel']").addEventListener("click", useTinder);
  startButton.addEventListener("click", () => resetGame(true));
  restartButton.addEventListener("click", () => resetGame(true));

  resetGame(false);
  requestAnimationFrame(frame);
})();
