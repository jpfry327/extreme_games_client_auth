/**
 * Cosmetic hit feedback (visual-only) — defender-authority relay model.
 *
 * Pins the load-bearing behaviour: an own shot overlapping a drawn enemy fires a
 * cosmetic hit exactly once (and only after surviving a frame, so it was reported),
 * never for the firer's own ship or a dead enemy, and `LocalSim.dropOwnProjectiles`
 * removes only the spent own shots.
 */

import { describe, expect, it } from "vitest";
import { WARBIRD, shipConfig } from "../config";
import { GameMap } from "../sim/gamemap";
import { createPlayer } from "../sim/player";
import type { Player, PlayerId, Projectile } from "../sim/types";
import { CosmeticHitDetector } from "./cosmeticHits";
import { LocalSim } from "./localSim";

function enemyAt(id: PlayerId, x: number, y: number): Player {
  return createPlayer(id, id, 1, WARBIRD, x, y);
}

function ownShot(owner: PlayerId, id: number, x: number, y: number, kind: Projectile["kind"] = "bullet"): Projectile {
  return {
    id, kind, owner, x, y, vx: 0, vy: 0, life: 50, bounces: 0,
    radius: shipConfig(WARBIRD).bullet.radius, alive: true, prevX: x, prevY: y,
  };
}

describe("CosmeticHitDetector", () => {
  it("fires once for an own shot overlapping a drawn enemy — but only after a frame", () => {
    const det = new CosmeticHitDetector();
    const enemy = enemyAt("enemy", 500, 500);
    const shot = ownShot("me", 1, 500, 500);

    // First frame: seen for the first time → not yet eligible (not yet reported).
    expect(det.detect([shot], [enemy])).toHaveLength(0);
    expect(det.isHit(1)).toBe(false);

    // Second frame: survived a frame → fires exactly one cosmetic hit.
    const hits = det.detect([shot], [enemy]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "bullet", target: "enemy", projectileId: 1 });
    expect(det.isHit(1)).toBe(true);

    // Third frame: already detonated → never fires again.
    expect(det.detect([shot], [enemy])).toHaveLength(0);
  });

  it("ignores a non-overlapping shot and a dead enemy", () => {
    const det = new CosmeticHitDetector();
    const far = ownShot("me", 1, 0, 0);
    const onTopButDead = ownShot("me", 2, 500, 500);
    const enemy = enemyAt("enemy", 500, 500);
    enemy.combat.respawnAt = 999; // dead/respawning ghost

    det.detect([far, onTopButDead], [enemy]); // prime prevSeen
    expect(det.detect([far, onTopButDead], [enemy])).toHaveLength(0);
  });

  it("dropOwnProjectiles removes only the spent own shots, never injected ones", () => {
    const sim = new LocalSim(new GameMap(64, 64, new Uint8Array(64 * 64)), ["me"]);
    sim.addOwned("me", "Me", 0, WARBIRD, 100, 100);
    // One own shot we'll "spend", one own shot we keep, plus an injected enemy shot.
    sim.world.projectiles.push(ownShot("me", 1, 100, 100));
    sim.world.projectiles.push(ownShot("me", 2, 200, 200));
    sim.injectIncoming([ownShot("enemy", 3, 150, 150)]);
    sim.step(new Map()); // flush the injected shot into the world

    sim.dropOwnProjectiles((id) => id === 1);

    const ids = sim.world.projectiles.map((p) => p.id).sort();
    expect(ids).toContain(2); // kept own shot
    expect(ids).toContain(3); // injected enemy shot — untouched
    expect(ids).not.toContain(1); // spent own shot — dropped
  });
});
