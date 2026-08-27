# Scrum Poker

A tiny, dependency-free scrum poker board. One shared room, two estimate
columns — **BE** and **FE** — and everyone's numbers stay hidden until the
round is revealed.

## Run it

```bash
node server.js
```

Then open http://localhost:3000. Set `PORT` to use another port:

```bash
PORT=8080 node server.js
```

Everyone on the same server shares one room, so for a remote session run it on
a machine the team can reach (or share the port over a tunnel).

## How it works

- Enter your name once — it is stored in `sessionStorage`, so it survives a
  refresh and is gone when the tab closes.
- Type a number or `?` into your **BE** and **FE** cells. Others see a ✓ that
  you have voted, not what you voted.
- **Reveal** shows every value plus the average, range, and a 🎉 when everyone
  agreed.
- **New round** clears all votes and hides them again.
- Participants disappear ~15 seconds after their tab closes, so a refresh does
  not drop you from the room.

State is in memory only — restarting the server empties the room.

## Layout

| File | Purpose |
| --- | --- |
| `server.js` | HTTP + Server-Sent Events server, room state, vote validation |
| `public/index.html` | Markup for the join form and the board |
| `public/app.js` | Client state, live updates, incremental table rendering |
| `public/styles.css` | Styling, light and dark |
