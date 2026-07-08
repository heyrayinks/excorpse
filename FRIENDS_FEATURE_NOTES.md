# Friends, Comments & Game Invites — dev notes (2026-07-08)

Deployed live at `excorpse-production.up.railway.app`, commit `669aaf1`.

## What shipped

- **Friends**: mutual-approval requests. Send by username (`POST /api/friends/requests`),
  accept/decline (`POST /api/friends/requests/:userId/accept|decline`), unfriend
  (`DELETE /api/friends/:userId`), list (`GET /api/friends`, sorted by games played
  together desc). If two people request each other before either accepts, it
  auto-accepts instead of erroring.
- **Comments**: on favorites and on profiles, gated to friends only (or yourself).
  `POST/DELETE /api/friends/:ownerId/favorites/:favoriteId/comments[/:commentId]` and
  the `.../profile/comments` equivalents. Only the content owner can delete a comment.
  All comment text is HTML-escaped client-side (`escapeHtml()` in index.html) before
  rendering — don't remove that when touching this code.
- **Games-played-together counter**: increments in `server.js`'s `/submit` handler
  when a game hits round 3 and everyone's submitted. Only counts pairs where both
  players were logged in when they joined (`player.userId`) — anonymous games never
  increment anything.
- **Game invites**: `POST /api/games/:code/invite` (creator-only, friends-only) creates
  an invite; the invitee sees it via `GET /api/friends/invites` and either
  `POST /api/friends/invites/:id/accept` (joins them into the game) or `.../decline`.
  If the in-memory game is gone by the time they accept (server restart), they get a
  410 and the stale invite is cleaned up automatically.

## Files touched

- New: `friends.js` (all friend/comment/invite business logic, mirrors `account.js`'s style)
- `data.js`: new `users.json` fields (`friends`, `friendRequestsSent/Received`,
  `gamesPlayedWith`, `profileComments`, `gameInvites`, plus `comments` on each
  favorite). A `normalizeUser()` helper backfills these on every read, so no migration
  script was needed for existing accounts.
- `auth.js`: added `tryExtractUserId(req)` — same as the existing token check but
  returns `null` instead of throwing. Used so game join/create can optionally attach
  identity without requiring login.
- `server.js`: all the new routes, plus `addPlayerToGame()` helper shared by `/join`
  and invite-accept.
- `index.html`: Friends/Comments/Invites UI on the account page, a new `friendProfile`
  screen, and a second 15s poll (separate from the in-game 2s poll) that only runs
  while on home/account/friendProfile — checks for new friend requests/invites and
  fires a browser notification via the existing `maybeNotify()`.

## Known limitations / things to know before touching this again

- **In-memory games, not persisted.** Same pre-existing limitation as before — a
  Railway restart mid-game loses active games. A pending invite that points at a
  restarted-away game returns 410, which is handled, but it's worth remembering this
  is the whole reason that code path exists.
- **No moderation beyond owner-delete.** No report button, no rate limiting on
  comments/friend requests. Fine at current (classroom) scale; revisit if abuse shows up.
- **No public gallery** — deliberately descoped. Favorites are only ever visible to
  the owner + their accepted friends, never to strangers.
- **Unfriending doesn't retroactively hide anything** — past comments and any
  already-sent game invite stay valid even after unfriending. Matches the "minimal
  moderation" decision made when this was planned; revisit if it becomes a problem.
- **Local dev `data/users.json` has test accounts** (`testFriendA/B/C`,
  `password123`) left over from verifying this feature — harmless, gitignored,
  delete the file locally if you want a clean slate (it self-recreates empty).

## Natural next steps, if you want to keep building on this

- A "friends" badge/count on the home screen so people notice pending requests
  without opening the account page (currently only surfaces via the account page +
  browser notification).
- Real push notifications (current notification system only fires while a tab is
  open — same limitation as the existing turn-notification feature, not new).
- Rate-limiting friend requests / comments if this ever gets abuse at a larger scale.
