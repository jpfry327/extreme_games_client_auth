import { describe, expect, it } from "vitest";
import { decode, encode, type NetMessage } from "./protocol";

/** Every wire message, one of each variant, to exercise encode→decode. */
const messages: NetMessage[] = [
  { t: "hello", name: "fecundity", team: 0, shipType: 0 },
  {
    t: "welcome",
    id: "p1",
    players: [{ id: "p2", name: "rival", team: 1, shipType: 0, x: 100, y: 200 }],
  },
  { t: "enter", player: { id: "p3", name: "third", team: 0, shipType: 0, x: 1, y: 2 } },
  { t: "leave", id: "p3" },
  {
    t: "pos",
    id: "p2",
    tick: 42,
    x: 512.5,
    y: 1024.25,
    vx: -1.5,
    vy: 2.5,
    rotation: 0.7853981633974483,
    energy: 1650,
    bounty: 7,
  },
];

describe("protocol encode/decode", () => {
  for (const msg of messages) {
    it(`round-trips a ${msg.t} message`, () => {
      expect(decode(encode(msg))).toEqual(msg);
    });
  }

  it("omits id on a client→server position packet", () => {
    const c2s: NetMessage = {
      t: "pos",
      tick: 1,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      rotation: 0,
      energy: 100,
      bounty: 0,
    };
    const decoded = decode(encode(c2s));
    expect(decoded).toEqual(c2s);
    expect("id" in decoded).toBe(false);
  });
});
