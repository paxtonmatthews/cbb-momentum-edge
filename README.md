# Momentum Edge 🏀

Live college basketball betting suggestions. Paste an ESPN game link and get:

- **Live momentum:** a momentum meter, current scoring run, last-4-minutes split, and a game-flow chart
- **Projected final score:** margin, total, and win probability, with 80% ranges
- **Fair live line:** where the spread, game total, moneyline, and each team's total *should* be right now
- **Screenshot your book:** upload, paste (Ctrl+V), or drop a screenshot of your sportsbook's live odds and the site reads the numbers for you. Text recognition runs in your browser, so the image never leaves your device.
- **Best bet:** every moneyline, spread, game total, and team total option is ranked by expected value, with a quarter-Kelly stake
- **Replay:** drag through any game to see what the model said at each moment. Finished games get graded.
- **All teams:** every Division I team (men's and women's) with season stats
- **Backtest:** replay hundreds of past games to check the model's accuracy

Works with men's and women's games.

> **For entertainment and research only.** Model estimates, not guarantees or financial advice. Bet only what you can afford to lose, and only where legal. Problem gambling help: 1-800-GAMBLER.

## How it works

It's a static site (plain HTML, CSS, and JavaScript, with no build step and no server). The browser pulls data straight from ESPN's public JSON feeds:

| Data | ESPN endpoint |
|---|---|
| Game: play-by-play, box score, line, win prob. | `site.api.espn.com/apis/site/v2/sports/basketball/{league}/summary?event={id}` |
| Scoreboard (all D-I) | `…/{league}/scoreboard?groups=50&dates=YYYYMMDD` |
| All teams | `…/{league}/teams?limit=1000` |
| Team season stats | `…/{league}/teams/{id}/statistics` |

These feeds are unofficial and can change without notice.

### Reading sportsbook screenshots (`js/oddsocr.js`)

1. The image is enlarged, converted to black text on white (dark-mode screenshots are flipped), and thresholded.
2. [Tesseract.js](https://github.com/naptha/tesseract.js) reads it twice in two layout modes, and the results are merged. Each mode misses different numbers on odds boards.
3. A layout parser uses each number's position: the Spread / Total / Moneyline headers mark columns, each line is paired with the price beside or below it, and each team's row runs to the next team name.
4. Common misreads are repaired: quote marks for minus signs, `0` for `O`, dropped decimals (`1325` → `132.5`), and a minus read as `1` (`1115` → `-115`). Any value whose sign had to be guessed is flagged in yellow.

On test images it read 36 of 39 numbers with **no wrong values**. Unreadable numbers are left blank. Always check the filled-in boxes against your book.

### The model (`js/model.js`)

1. **Baseline:** the pregame betting line (spread and total) from ESPN. If there isn't one, season scoring averages are used.
2. **Margin:** a Brownian-motion-with-drift model (Stern 1994). The drift blends the pregame spread with the in-game scoring rate, trusting the game more as it goes on. Leads shrink slightly over time.
3. **Total:** in-game scoring pace compared with what the pregame total expected, after removing three-point shooting luck. Extra points are added for late-game fouling, scaled by how close the game is.
4. **Uncertainty:** a random-walk spread plus a small floor. Both were fitted on 399 games and checked on 268 unseen games.
5. **Team totals:** each team's score is (total ± margin) / 2. Its uncertainty combines the total and margin uncertainty, widened 8% to match a 240-game backtest.
6. **Bets:** each option's win chance vs. the price's implied chance gives expected value. Under +2% EV the verdict is "pass".
7. **Momentum:** shown but not used in the projection by default. Research says runs barely predict the future, and live markets tend to *overreact* to them.

Every number, with sources and backtest results, is in **[RESEARCH.md](RESEARCH.md)**.

## Run it locally

Any static file server works, for example:

```bash
python -m http.server 8765
```

Then open http://localhost:8765. (ES modules don't load from `file://`, so you need a server.)

## Deploy (free) with GitHub Pages

Repo **Settings → Pages → Source: Deploy from a branch → `main` / root**. The site goes live at `https://<username>.github.io/<repo>/`.

## Project layout

```
index.html      live game page
teams.html      all Division I teams + season stats
backtest.html   model accuracy check on past games
css/style.css
js/espn.js      ESPN fetching + data cleanup
js/model.js     the model (pure functions, tune CONFIG at the top)
js/oddsocr.js   sportsbook screenshot reader
js/app.js       live game page UI
js/teams.js     teams page UI
js/backtest.js  backtest runner
RESEARCH.md     studies and backtest results behind the model
```

## Ideas / roadmap

- Live odds API so lines fill in automatically (and a real profit backtest)
- Tempo-free team ratings as a second baseline
- Possession counting from play-by-play
- Foul trouble and lineup adjustments
- A separate tune for the women's game
