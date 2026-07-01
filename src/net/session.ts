/**
 * Session — connection lifecycle + the bridge between the wire and the world
 * (netcode §8). Owns the transport and the server-assigned network id, dispatches
 * incoming messages into `remotePlayers`, and pushes the local ship's position
 * out at ~10 Hz.
 *
 * The local player keeps its world key `localPlayerId` ("local") — it is never
 * renamed. The server-assigned `myId` lives only here: it stamps outbound intent
 * and lets us ignore the echo of our own position, while remotes are keyed by
 * their own network ids.
 */

import { decode, encode, type PositionMessage, type WeaponDescriptor } from "./protocol";
import { RemotePlayers } from "./remotePlayers";
import type { Transport } from "./transport";
import type { World } from "../sim/world";
import type { PlayerId } from "../sim/types";

/** ~10 Hz outbound position rate (netcode §3: "min every 5 ticks"). */
const POSITION_INTERVAL_MS = 100;

export class Session {
  /** The relay-assigned id for our own ship; null until `welcome` arrives. */
  private myId: PlayerId | null = null;
  private open = false;
  private lastSentMs = 0;

  /** Playback + smoothing for every non-local ship (netcode §4). */
  private readonly remotes = new RemotePlayers();

  constructor(
    private readonly transport: Transport,
    private readonly world: World,
  ) {
    transport.onOpen(() => this.onOpen());
    transport.onClose(() => (this.open = false));
    transport.onMessage((data) => this.onMessage(data));
  }

  /** Advance remote-player smoothing by one sim tick. Call once per fixed tick,
   *  in lockstep with `world.step()`, so the renderer's tick interpolation lines
   *  up (netcode §4 step 6). */
  advanceRemotes(): void {
    this.remotes.advanceTick(this.world);
  }

  /** True once the socket is open (whether or not `welcome` has landed yet). */
  get connected(): boolean {
    return this.open;
  }

  /** Everyone in the arena, counting the local ship. */
  get playerCount(): number {
    return this.world.players.size;
  }

  /**
   * Push the local ship's pose to the relay. Called once per rendered frame from
   * the main loop (`nowMs` is a real-time clock). Two triggers (netcode §3):
   *
   *   - **On every shot**, immediately — one packet per `weaponFired` event this
   *     frame, each carrying that shot's weapon descriptor so remotes spawn the
   *     projectile at once. This is what makes fires feel instant, and it
   *     bypasses the throttle.
   *   - **Otherwise**, the steady ~10 Hz cadence, with no weapon (a bare weapon
   *     field would make a remote double-spawn).
   */
  maybeSendPosition(nowMs: number): void {
    if (!this.open || this.myId === null) return;

    let fired = false;
    for (const e of this.world.events) {
      if (e.type !== "weaponFired" || e.owner !== this.world.localPlayerId) continue;
      this.send(nowMs, { kind: e.kind });
      fired = true;
    }
    if (fired) return; // a shot already carried this frame's pose out

    if (nowMs - this.lastSentMs < POSITION_INTERVAL_MS) return;
    this.send(nowMs);
  }

  /** Encode and send one position packet for the local ship's current pose,
   *  optionally folding in a weapon descriptor. Resets the throttle clock. */
  private send(nowMs: number, weapon?: WeaponDescriptor): void {
    this.lastSentMs = nowMs;
    const me = this.world.localPlayer;
    const k = me.kinematics;
    const pkt: PositionMessage = {
      t: "pos",
      tick: this.world.tick,
      x: k.x,
      y: k.y,
      vx: k.vx,
      vy: k.vy,
      rotation: k.rotation,
      energy: me.resources.energy,
      bounty: me.combat.bounty,
      ...(weapon ? { weapon } : {}),
    };
    this.transport.sendUnreliable(encode(pkt));
  }

  private onOpen(): void {
    this.open = true;
    const me = this.world.localPlayer;
    this.transport.sendReliable(
      encode({ t: "hello", name: me.name, team: me.team, shipType: me.shipType }),
    );
  }

  private onMessage(data: string): void {
    let msg;
    try {
      msg = decode(data);
    } catch {
      return; // drop malformed frames
    }

    switch (msg.t) {
      case "welcome":
        this.myId = msg.id;
        for (const info of msg.players) {
          if (info.id !== this.myId) this.remotes.ensureRemote(this.world, info);
        }
        break;
      case "enter":
        if (msg.player.id !== this.myId) this.remotes.ensureRemote(this.world, msg.player);
        break;
      case "leave":
        this.remotes.removeRemote(this.world, msg.id);
        break;
      case "pos":
        if (msg.id !== this.myId) this.remotes.applyPosition(this.world, msg);
        break;
      // hello is C2S only; ignore if ever echoed back.
    }
  }
}
