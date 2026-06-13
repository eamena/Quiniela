# World Cup Prediction Pool

Web app that imports your Excel pool predictions, calculates standings automatically, and syncs latest World Cup results through a bot.

## Scoring rules

- Correct outcome (home win / draw / away win): **2 points**
- Exact scoreline: **5 points total**

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
copy .env.example .env
```

3. (Optional but recommended) set your `FOOTBALL_DATA_API_TOKEN` in `.env`.
   - Get a token at: https://www.football-data.org/

4. Start the app:

```bash
npm run dev
```

5. Open:

```text
http://localhost:3000
```

## Useful commands

- `npm run import` → Re-imports predictions from Excel file
- `npm run sync` → Pulls finished World Cup results from the API and updates standings

## UI

- **Overview tab**: standings + latest results + top metrics
- **Match timeline**: chronological order with previous 1 or 2 days + upcoming matches
- **Participant view tab**: pick a participant and see only their predictions, match-by-match points, and personal totals
- **Bilingual UI (English/Spanish)**: defaults from browser language and can be changed manually in the header
- **Knockout phase support**: round windows for LAST_32, LAST_16, QUARTER_FINALS, SEMI_FINALS, and FINAL are stored in DB, with participant-entry banners starting 24h before each window opens

## API endpoints

- `GET /api/standings`
- `GET /api/matches/latest?limit=120&daysBack=2`
- `GET /api/participants`
- `GET /api/participants/:participantId/predictions`
- `GET /api/knockout/context?participantId=ID`
- `POST /api/knockout/predictions`
- `POST /api/import`
- `POST /api/scores/sync`
- `POST /api/results/manual`

### Manual result payload

```json
{
  "matchId": 1,
  "homeScore": 2,
  "awayScore": 1,
  "status": "finished"
}
```
