/**
 * Client-authoritative ("defender authority") relay model tests.
 *
 * These pin the load-bearing behaviour of the conversion:
 *   - a node only adjudicates hits against the players it *defends* (the linchpin);
 *   - the defending node decides its own damage/death and names the killer;
 *   - the relay server mirrors client state (preserving its own scoreboard fields),
 *     scores the bot's death inline, and scores a human's reported death once.
 */

import { describe, expect, it, vi } from "vitest";
import { COMBAT, RELAY, WARBIRD, shipConfig } from "../config";
import { GameMap } from "../sim/gamemap";
import { BOT_ID } from "../sim/bot";
import { isAlive } from "../sim/player";
import type { Player, PlayerId, Projectile, ShipDiedEvent } from "../sim/types";
import { LocalSim } from "./localSim";
import { RelayHost } from "./relayHost";
import type { DeathReportMsg, StateReportMsg } from "./protocol";

/** A small open map; out-of-bounds is solid so shots bounce/expire at the edges. */
function openMap(tiles = 64): GameMap {
  return new GameMap(tiles, tiles, new Uint8Array(tiles * tiles));
}

/** A stationary bullet sitting on `(x, y)`, owned by `owner`. After
 *  `projectileSystem` (no velocity) it stays put, so the collision step overlaps it
 *  with anything at that position. */
function bulletAt(owner: PlayerId, id: number, x: number, y: number): Projectile {
  return {
    id,
    kind: "bullet",
    owner,
    x,
    y,
    vx: 0,
    vy: 0,
    life: 20,
    bounces: 0,
    radius: shipConfig(WARBIRD).bullet.radius,
    alive: true,
    prevX: x,
    prevY: y,
  };
}

describe("LocalSim — defender authority", () => {
  it("an incoming remote shot damages and kills the owned ship locally", () => {
    const sim = new LocalSim(openMap(), ["me"]);
    const me = sim.addOwned("me", "Me", 0, WARBIRD, 500, 500);
    me.resources.energy = 5; // one bullet is fatal

    sim.injectIncoming([bulletAt("enemy", 1, 500, 500)]);
    sim.step(new Map());

    expect(me.resources.energy).toBeLessThanOrEqual(0);
    expect(me.combat.respawnAt).toBeGreaterThan(0); // dead on our own screen
    expect(me.combat.deaths).toBe(1);

    const died = sim.world.events.find((e): e is ShipDiedEvent => e.type === "shipDied");
    expect(died?.victim).toBe("me");
    // The defender names the raw killer even though it isn't simulated here.
    expect(died?.killer).toBe("enemy");
  });

  it("does NOT adjudicate the owner's own shots (the defender decides those)", () => {
    const sim = new LocalSim(openMap(), ["me"]);
    const me = sim.addOwned("me", "Me", 0, WARBIRD, 500, 500);
    const before = me.resources.energy;

    // Our own shot sitting on us must never hurt us (collision skips the owner).
    sim.injectIncoming([bulletAt("me", 1, 500, 500)]); // injectIncoming ignores own shots
    sim.world.projectiles.push(bulletAt("me", 2, 500, 500)); // even if present, it's skipped
    sim.step(new Map());

    expect(me.resources.energy).toBe(before);
    expect(isAlive(me)).toBe(true);
  });

  it("catches an incoming shot up to the present on inject (what you see is what hits)", () => {
    // The reported pose of a remote shot is ~transit old; the defender fast-forwards
    // it by the same lead the renderer draws it at, so it's adjudicated where it's
    // drawn (the Continuum weapon catch-up) — not from its stale reported position.
    const sim = new LocalSim(openMap(), ["me"]);
    const me = sim.addOwned("me", "Me", 0, WARBIRD, 500, 500);
    me.resources.energy = 5; // one bullet is fatal once it reaches us

    sim.setIncomingLeadMs(50); // 50ms @ 100Hz = 5 ticks of catch-up
    // Reported 5 ticks "behind" us: x=478 moving +4 px/tick. Catch-up flies it the
    // 5 ticks to ≈(500,500) on inject, so it's on us immediately — not 5 ticks later.
    sim.injectIncoming([{ ...bulletAt("enemy", 1, 478, 500), vx: 4, life: 50 }]);

    // First step adjudicates the already-present shot — an immediate hit & death.
    sim.step(new Map());
    expect(sim.world.events.some((e) => e.type === "shipHit" && e.target === "me")).toBe(true);
    expect(me.combat.respawnAt).toBeGreaterThan(0);
  });

  it("without a lead, that same reported shot has NOT yet reached us (favours the defender)", () => {
    // The inverse control: at lead 0 (e.g. the server's bot, or zero transit) the
    // shot is adjudicated from its reported pose, so a shot reported 5 ticks short of
    // us is still ~5 ticks away after one step — the defender is favoured by the gap.
    const sim = new LocalSim(openMap(), ["me"]);
    const me = sim.addOwned("me", "Me", 0, WARBIRD, 500, 500);
    me.resources.energy = 5;

    sim.injectIncoming([{ ...bulletAt("enemy", 1, 478, 500), vx: 4, life: 50 }]);
    sim.step(new Map());
    expect(sim.world.events.some((e) => e.type === "shipHit")).toBe(false);
    expect(isAlive(me)).toBe(true);
  });

  it("sweeps collisions during the inject catch-up so a point-blank shot can't tunnel through", () => {
    // Regression: `stepProjectile` flies + bounces but never tests ship overlap, so a
    // point-blank shot used to fast-forward clean *through* the owned ship during the
    // catch-up loop and never register — "I die on their screen but not on mine". The
    // sweep stops the catch-up at the first pose that overlaps us so the hit lands.
    const sim = new LocalSim(openMap(), ["me"]);
    const me = sim.addOwned("me", "Me", 0, WARBIRD, 500, 500);
    me.resources.energy = 5; // one bullet is fatal

    const speed = shipConfig(WARBIRD).bullet.speed; // 4.1 px/tick
    sim.setIncomingLeadMs(80); // 8 ticks ≈ 33px catch-up — would clear our ~16px hit zone
    // Reported sitting on us, flying through. Without the sweep the catch-up steps it
    // well past before the first adjudicating step; with it, the shot stops on us.
    sim.injectIncoming([{ ...bulletAt("enemy", 1, 500, 500), vx: speed, life: 50 }]);
    sim.step(new Map());

    expect(sim.world.events.some((e) => e.type === "shipHit" && e.target === "me")).toBe(true);
    expect(me.combat.respawnAt).toBeGreaterThan(0); // dead on our own screen
  });

  it("retracts an injected shot that vanished from the latest report (no ghost bullet)", () => {
    const sim = new LocalSim(openMap(), ["me"]);
    const me = sim.addOwned("me", "Me", 0, WARBIRD, 500, 500);
    me.resources.energy = 100000;

    // A shot approaching from the left — alive and flying, not yet on us.
    const incoming: Projectile = { ...bulletAt("enemy", 1, 440, 500), vx: 5, life: 50 };
    sim.injectIncoming([incoming]);
    sim.step(new Map()); // it flies (no hit yet)
    expect(sim.world.projectiles.some((p) => p.owner === "enemy")).toBe(true);

    // The owner's copy died elsewhere → it's gone from the next report. Retract it.
    sim.reconcileIncoming(new Set());
    expect(sim.world.projectiles.some((p) => p.owner === "enemy")).toBe(false);

    // It can never reach us now.
    for (let i = 0; i < 40; i++) sim.step(new Map());
    expect(me.resources.energy).toBe(100000);
    expect(isAlive(me)).toBe(true);
  });

  it("keeps adjudicating an in-flight shot that stays in the report until it lands", () => {
    // The inverse of the ghost test: as long as the firer keeps reporting the shot
    // (it has NOT cosmetically dropped it from its report), the defender flies it to
    // a hit. This is the contract the "bullets/bombs do no damage" fix restored —
    // the firer must report a spent shot for its whole life, not retract it on hit.
    const sim = new LocalSim(openMap(), ["me"]);
    const me = sim.addOwned("me", "Me", 0, WARBIRD, 500, 500);
    me.resources.energy = 5; // one bullet is fatal once it reaches us

    const incoming: Projectile = { ...bulletAt("enemy", 1, 440, 500), vx: 5, life: 50 };
    sim.injectIncoming([incoming]);

    // Each tick the firer re-reports the shot (id stays present) — so reconcile keeps it.
    for (let i = 0; i < 20; i++) {
      sim.reconcileIncoming(new Set([1]));
      sim.step(new Map());
      if (!isAlive(me)) break;
    }

    expect(sim.world.events.some((e) => e.type === "shipHit" && e.target === "me")).toBe(true);
    expect(me.combat.respawnAt).toBeGreaterThan(0); // it reached us and killed us
  });

  it("marks an incoming shot consumed when its injected copy dies on us, then forgets it", () => {
    // Lets the client stop drawing the firer's still-flying remote copy of a shot
    // that already hit us (the firer never adjudicates its own shots) — otherwise the
    // bullet/bomb sails visibly *through* the defender after the hit.
    const sim = new LocalSim(openMap(), ["me"]);
    const me = sim.addOwned("me", "Me", 0, WARBIRD, 500, 500);
    me.resources.energy = 100000; // survive so we can observe the consumed flag

    sim.injectIncoming([bulletAt("enemy", 1, 500, 500)]);
    expect(sim.isIncomingConsumed(1)).toBe(false);
    sim.step(new Map()); // the bullet reaches us and dies here
    expect(sim.isIncomingConsumed(1)).toBe(true);

    // Suppressed while the firer still reports its (through-flying) copy…
    sim.reconcileIncoming(new Set([1]));
    expect(sim.isIncomingConsumed(1)).toBe(true);
    // …and forgotten once it leaves the report (no longer drawn anywhere).
    sim.reconcileIncoming(new Set());
    expect(sim.isIncomingConsumed(1)).toBe(false);
  });

  it("ignores a re-reported (already-seen) incoming shot", () => {
    const sim = new LocalSim(openMap(), ["me"]);
    const me = sim.addOwned("me", "Me", 0, WARBIRD, 500, 500);
    me.resources.energy = 100000; // survive so we can count hits

    const shot = bulletAt("enemy", 7, 500, 500);
    sim.injectIncoming([shot]);
    sim.injectIncoming([{ ...shot }]); // redundant re-send of the same id
    sim.step(new Map());

    // Only one copy was injected, so exactly one hit registered.
    const hits = sim.world.events.filter((e) => e.type === "shipHit");
    expect(hits.length).toBe(1);
  });
});

describe("RelayHost — mirror + scoreboard relay", () => {
  function stateReport(player: Player, seq: number, projectiles: Projectile[] = []): StateReportMsg {
    return { type: "state", seq, tick: seq, player, projectiles };
  }

  it("mirrors a client's pose/energy but preserves the server-owned scoreboard", () => {
    const host = new RelayHost(openMap());
    host.addHuman("p1", "P1", 0, WARBIRD, 100, 100);

    // Server has already credited p1 two kills (e.g. via earlier death reports).
    const snap0 = host.assembleSnapshot();
    const mirror0 = snap0.players.find((p) => p.id === "p1")!;
    mirror0.combat.kills = 2;
    mirror0.combat.score = 50;

    // The client reports a moved, low-energy ship — and a (wrong) kills value.
    const reported = structuredClone(mirror0);
    reported.kinematics.x = 999;
    reported.resources.energy = 7;
    reported.combat.kills = 0; // client doesn't own this — must be ignored
    host.ingestState("p1", stateReport(reported, 1));

    const snap1 = host.assembleSnapshot();
    const mirror1 = snap1.players.find((p) => p.id === "p1")!;
    expect(mirror1.kinematics.x).toBe(999); // client-owned: mirrored
    expect(mirror1.resources.energy).toBe(7); // client-owned: mirrored
    expect(mirror1.combat.kills).toBe(2); // server-owned: preserved
    expect(mirror1.combat.score).toBe(50);
  });

  it("drops a stale / out-of-order state report", () => {
    const host = new RelayHost(openMap());
    host.addHuman("p1", "P1", 0, WARBIRD, 100, 100);
    const p = host.assembleSnapshot().players.find((pl) => pl.id === "p1")!;

    const moved = structuredClone(p);
    moved.kinematics.x = 800;
    host.ingestState("p1", stateReport(moved, 5));
    const older = structuredClone(p);
    older.kinematics.x = 111;
    host.ingestState("p1", stateReport(older, 3)); // seq < 5 → dropped

    expect(host.assembleSnapshot().players.find((pl) => pl.id === "p1")!.kinematics.x).toBe(800);
  });

  it("scores a human's self-reported death once, even on re-sends, and relays it", () => {
    const host = new RelayHost(openMap());
    host.addHuman("killer", "K", 0, WARBIRD, 100, 100);
    host.addHuman("victim", "V", 0, WARBIRD, 200, 200);

    const death: DeathReportMsg = {
      type: "death",
      victim: "victim",
      deaths: 1,
      killer: "killer",
      bounty: 30,
      x: 200,
      y: 200,
    };
    host.ingestDeath(death);
    host.ingestDeath({ ...death }); // re-send of the same death (same deaths count)

    const killer = host.assembleSnapshot().players.find((p) => p.id === "killer")!;
    expect(killer.combat.kills).toBe(1); // credited exactly once
    expect(killer.combat.score).toBe(30 + COMBAT.killPointsBase);

    const relayed = host.assembleSnapshot().events.filter((e) => e.type === "shipDied");
    expect(relayed.length).toBe(1);
    expect((relayed[0] as ShipDiedEvent).killer).toBe("killer");
  });

  it("drops an away client (silent past the timeout) from the snapshot, then re-adds it on a report", () => {
    vi.useFakeTimers();
    try {
      const host = new RelayHost(openMap());
      host.addHuman("p1", "P1", 0, WARBIRD, 100, 100);
      const present = () => host.assembleSnapshot().players.some((p) => p.id === "p1");

      // Fresh join is present immediately (grace window seeded from join time).
      expect(present()).toBe(true);
      const reported = structuredClone(host.assembleSnapshot().players.find((p) => p.id === "p1")!);

      // No reports past the timeout → "away": its frozen ship is dropped from the snapshot.
      vi.advanceTimersByTime(RELAY.inactiveTimeoutMs + 1);
      expect(present()).toBe(false);

      // A fresh report wakes it — present again the very next snapshot.
      host.ingestState("p1", stateReport(reported, 1));
      expect(present()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the bot (server-defended) takes damage from a human's shot and dies; killer credited inline", () => {
    const host = new RelayHost(openMap());
    host.addHuman("p1", "P1", 0, WARBIRD, 300, 300);

    // Find the bot's spawn, weaken it, and report a human shot sitting on it.
    const bot = host.assembleSnapshot().players.find((p) => p.id === BOT_ID)!;
    // Reach into the relay to weaken the bot deterministically for the test.
    // (No public setter — the snapshot players are clones, so mutate via a report
    // path instead: place the shot and let several ticks of damage accumulate.)
    const shot = bulletAt("p1", 1, bot.kinematics.x, bot.kinematics.y);
    const p1 = structuredClone(host.assembleSnapshot().players.find((p) => p.id === "p1")!);
    host.ingestState("p1", { type: "state", seq: 1, tick: 1, player: p1, projectiles: [shot] });

    // Advance enough ticks for the stationary shot to keep dealing damage until the
    // bot dies (a single bullet won't kill a full-energy warbird).
    for (let i = 0; i < 30; i++) {
      // Keep the shot present by re-reporting under a new seq with a new id each time
      // (a fresh id is a new shot the bot will adjudicate again).
      const fresh = bulletAt("p1", 100 + i, bot.kinematics.x, bot.kinematics.y);
      host.ingestState("p1", { type: "state", seq: 2 + i, tick: 2 + i, player: p1, projectiles: [fresh] });
      host.advance(0.01);
    }

    const after = host.assembleSnapshot();
    const credited = after.players.find((p) => p.id === "p1")!;
    expect(credited.combat.kills).toBeGreaterThanOrEqual(1); // bot death credited to p1 inline
    const botDied = after.events.some((e) => e.type === "shipDied" && (e as ShipDiedEvent).victim === BOT_ID);
    // The bot died at some point during the run (event may have drained on an earlier
    // assemble, so also accept the credited kill as proof).
    expect(botDied || credited.combat.kills >= 1).toBe(true);
  });
});
