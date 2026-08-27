'use strict';

const COLUMNS = ['be', 'fe'];
const VALUE_PATTERN = /^(\?|\d{1,3}(\.\d)?)$/;

const el = {
  status: document.getElementById('status'),
  joinForm: document.getElementById('join-form'),
  joinName: document.getElementById('join-name'),
  board: document.getElementById('board'),
  rows: document.getElementById('rows'),
  summary: document.getElementById('summary'),
  reveal: document.getElementById('reveal'),
  reset: document.getElementById('reset'),
  round: document.getElementById('round'),
};

const me = {
  id: sessionStorage.getItem('poker.id') || crypto.randomUUID(),
  name: sessionStorage.getItem('poker.name') || '',
};
sessionStorage.setItem('poker.id', me.id);

const rowsById = new Map();
const pendingSends = new Map();
const editedAt = new Map();
const LOCAL_EDIT_WINS_MS = 1500;

// ---------------------------------------------------------------- api

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
}

function sendVote(column, value) {
  clearTimeout(pendingSends.get(column));
  pendingSends.set(
    column,
    setTimeout(() => {
      post('/api/vote', { id: me.id, column, value: value || null })
        .catch((err) => setStatus(`Could not save vote: ${err.message}`));
    }, 200)
  );
}

function setStatus(text) {
  el.status.textContent = text;
}

// ---------------------------------------------------------------- rendering

// Keeps the field to something the server will accept: "?" or up to 3 digits
// with one optional decimal.
function sanitise(raw) {
  if (raw.includes('?')) return '?';
  const digits = raw.replace(/[^\d.]/g, '').replace(/^\.+/, '');
  return (digits.match(/^\d{0,3}(\.\d?)?/) || [''])[0];
}

function buildVoteInput(column) {
  const input = document.createElement('input');
  input.className = 'vote-input';
  input.setAttribute('aria-label', `Your ${column.toUpperCase()} estimate`);
  input.autocomplete = 'off';
  input.placeholder = '–';
  input.addEventListener('input', () => {
    input.value = sanitise(input.value);
    editedAt.set(column, Date.now());
    const value = input.value;
    if (value === '' || VALUE_PATTERN.test(value)) sendVote(column, value);
  });
  return input;
}

function buildRow(participant) {
  const isMe = participant.id === me.id;
  const row = document.createElement('tr');
  if (isMe) row.className = 'me';

  const nameCell = document.createElement('td');
  nameCell.className = 'col-name';
  row.append(nameCell);

  const cells = {};
  for (const column of COLUMNS) {
    const cell = document.createElement('td');
    cell.className = 'col-vote';
    if (isMe) cell.append(buildVoteInput(column));
    row.append(cell);
    cells[column] = cell;
  }
  return { row, nameCell, cells, isMe };
}

function renderOtherVote(cell, vote) {
  const chip = document.createElement('span');
  if (vote.value !== null) {
    chip.className = 'chip revealed';
    chip.textContent = vote.value;
  } else if (vote.voted) {
    chip.className = 'chip';
    chip.textContent = '✓';
  } else {
    chip.className = 'chip empty';
    chip.textContent = '–';
  }
  cell.replaceChildren(chip);
}

function renderSummary(summary) {
  el.summary.hidden = !summary;
  if (!summary) return;
  for (const column of COLUMNS) {
    const cell = document.getElementById(`summary-${column}`);
    const stats = summary[column];
    cell.className = `col-vote${stats.agreed ? ' agreed' : ''}`;
    if (stats.average === null) {
      cell.textContent = '–';
    } else if (stats.agreed) {
      cell.textContent = `${stats.average} 🎉`;
    } else if (stats.min === stats.max) {
      cell.textContent = `${stats.average}`;
    } else {
      cell.textContent = `${stats.average} (${stats.min}–${stats.max})`;
    }
  }
}

// The server echoes our own votes back, so inputs survive a refresh — but a value
// we just typed must not be overwritten by a broadcast that predates it.
function syncOwnInput(input, column, vote) {
  if (document.activeElement === input) return;
  if (Date.now() - (editedAt.get(column) || 0) < LOCAL_EDIT_WINS_MS) return;
  const value = vote.value === null ? '' : vote.value;
  if (input.value !== value) input.value = value;
}

function render(state) {
  const seen = new Set();
  for (const participant of state.participants) {
    seen.add(participant.id);
    let entry = rowsById.get(participant.id);
    if (!entry) {
      entry = buildRow(participant);
      rowsById.set(participant.id, entry);
    }
    el.rows.append(entry.row); // keeps DOM order in sync with server order
    entry.nameCell.textContent = participant.name;
    if (entry.isMe) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = ' (you)';
      entry.nameCell.append(you);
    }

    for (const column of COLUMNS) {
      const vote = participant.votes[column];
      if (entry.isMe) {
        const input = entry.cells[column].querySelector('.vote-input');
        input.disabled = state.revealed;
        syncOwnInput(input, column, vote);
      } else {
        renderOtherVote(entry.cells[column], vote);
      }
    }
  }

  for (const [id, entry] of rowsById) {
    if (!seen.has(id)) {
      entry.row.remove();
      rowsById.delete(id);
    }
  }

  renderSummary(state.summary);
  el.reveal.disabled = state.revealed;
  el.round.textContent = `Round ${state.round} · ${state.participants.length} in room`;
}

// ---------------------------------------------------------------- session

function connect() {
  const source = new EventSource(`/api/events?id=${encodeURIComponent(me.id)}`);
  source.addEventListener('open', () => {
    setStatus(`Connected as ${me.name}`);
    // Re-announce ourselves: covers a dropped connection or a server restart.
    post('/api/join', { id: me.id, name: me.name }).catch(() => {});
  });
  source.addEventListener('message', (event) => render(JSON.parse(event.data)));
  source.addEventListener('error', () => setStatus('Reconnecting…'));
}

async function join(name) {
  me.name = name;
  sessionStorage.setItem('poker.name', name);
  await post('/api/join', { id: me.id, name });
  el.joinForm.hidden = true;
  el.board.hidden = false;
  connect();
}

el.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = el.joinName.value.trim();
  if (name) join(name).catch((err) => setStatus(err.message));
});

el.reveal.addEventListener('click', () => post('/api/reveal', {}).catch((e) => setStatus(e.message)));
el.reset.addEventListener('click', () => post('/api/reset', {}).catch((e) => setStatus(e.message)));

if (me.name) {
  el.joinName.value = me.name;
  join(me.name).catch((err) => setStatus(err.message));
} else {
  setStatus('Pick a name to join the room.');
}
