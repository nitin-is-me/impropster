/** Dumps what each client actually receives, to debug per-client filtering. */
import { Client, type Room } from "@colyseus/sdk";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const client = new Client("http://localhost:2567");

const rooms: Room<any, any>[] = [];
for (let i = 0; i < 3; i++) {
  rooms.push((await client.joinOrCreate("match", { name: `p${i}` })) as Room<any, any>);
}

await sleep(1000);
const dump = (label: string) => {
  for (const room of rooms) {
    const state = room.state as any;
    const self = state.players.get(room.sessionId);
    const rows: string[] = [];
    for (const [id, p] of state.players) {
      rows.push(
        `${id === room.sessionId ? "SELF" : id.slice(0, 4)} role=${p.role} form=${p.form} x=${Math.round(p.x)} y=${Math.round(p.y)} name=${JSON.stringify(p.name)}`,
      );
    }
    console.log(`${label} | ${room.sessionId.slice(0, 4)} phase=${state.phase} size=${state.players.size} :: ${rows.join(" ; ")}`);
  }
};

dump("lobby");
// wait for hide
while ((rooms[0]?.state as any).phase !== 1) await sleep(100);
await sleep(500);
dump("hide");

// wait for hunt
while ((rooms[0]?.state as any).phase !== 2) await sleep(100);
await sleep(500);
dump("hunt");

for (const room of rooms) room.leave();
process.exit(0);
