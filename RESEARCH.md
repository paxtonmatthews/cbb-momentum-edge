# Research behind the model

This page lists the studies and expert work the model is built on, what each one says, and exactly where it shows up in [`js/model.js`](js/model.js). At the end are results from our own backtest on about 670 real games.

**Short version:**

1. A basketball score behaves almost like a random walk with a small drift (the better team's edge).
2. Scoring runs and the "hot hand" predict very little.
3. Three-point percentage swings are mostly luck.
4. Late-game fouling adds points in close games.
5. Betting markets are hard to beat, but live markets tend to overreact to recent events.

So the model projects the rest of the game from the pregame line plus a cautious read of what's happened so far. It shows momentum but doesn't chase it, and it looks for spots where the live line has moved further than the evidence supports.

---

## 1. How scores move during a game

| Source | Finding | Used in the model |
|---|---|---|
| Stern, H. (1994). *A Brownian motion model for the progress of sports scores.* Journal of the American Statistical Association, 89(427). [link](https://www.semanticscholar.org/paper/A-Brownian-Motion-Model-for-the-Progress-of-Sports-Stern/0d6ab5030159b28739bbcb39f716e896d18875d6) | The home-minus-away margin can be modeled as Brownian motion with drift. This is the foundation of most in-game win-probability models. | The core of `analyze()`: projected margin = current margin + drift × time left. Uncertainty grows with √(time left). |
| Gabel, A. & Redner, S. (2012). *Random walk picture of basketball scoring.* Journal of Quantitative Analysis in Sports. [arXiv:1109.2825](https://arxiv.org/abs/1109.2825) | Using NBA play-by-play: scoring is "nearly memory-less", with correlations under 0.03. Bursts and droughts come from random chance, not hot streaks. Right after a score, the *same* team scores next only **34.8%** of the time (anti-persistence). There's also a small "restoring force": the scoring rate shifts about **0.0022 per point of lead** in the trailing team's favor. | Momentum has **zero weight** in the projection by default (`momentumWeight: 0`). Leads shrink slightly (`restoring`), set at about half the paper's NBA estimate to stay conservative for college. |
| Thompson, J. (2017). *Making win probability plots.* [link](https://wjakethompson.com/blog/2017-01-11-basketball-win-probability/) | College prediction error is roughly normal with **SD ≈ 11.4 points**, scaling as σ·√(minutes left / 40). | Starting value for `marginSD`. |
| *The Variance of College Basketball* (The Only Colors, 2020). [link](https://www.theonlycolors.com/2020/4/27/21226073/the-variance-of-college-basketball-how-big-is-it-and-where-does-it-come-from) | The SD of a college game's final margin around expectation is about **10 points**. | Cross-check on `marginSD`. Our own data gave **10.9** against the closing spread. |
| Mealy, Mealy, Miller & N'Dione. *Calibration and comeback risk in NBA in-game win-probability models.* [PDF](https://web.williams.edu/Mathematics/sjmiller/public_html/math/papers/WinProbModelAccuracyInNBA_MealyMealyMillerNDione.pdf) | Reviews Stern-style models and checks their calibration. Simple models can be overconfident about big leads. | Why we backtested calibration and added an uncertainty floor (`marginSDFloor`, `totalSDFloor`). |
| Wolfers, J. *Point Shaving: Corruption in NCAA Basketball.* [PDF](https://users.nber.org/~jwolfers/Papers/PointShaving.pdf) | Game outcomes minus the spread are roughly normal with mean zero. | Supports using a normal distribution to price spreads and totals. |

## 2. Momentum, runs, and the hot hand

| Source | Finding | Used in the model |
|---|---|---|
| Gilovich, Vallone & Tversky (1985). *The hot hand in basketball.* Cognitive Psychology. | The classic study: people see streaks in random sequences. | Context. |
| Miller, J. & Sanjurjo, A. (2018). *Surprised by the hot hand fallacy?* Econometrica. | Found a statistical bias in the 1985 method. A small individual hot hand may exist after all. | Momentum weight can be turned up in settings, but defaults to 0. |
| *The Hot Hand in the NBA 3-Point Contest* (NBER working paper w29468). [NBER w29468](https://www.nber.org/system/files/working_papers/w29468/w29468.pdf) | Any hot hand shows up only in very controlled, repeated shooting, and **likely not in the run of play**. | Same. |
| Gibbs, Elmore & Fosdick (2022). *The causal effect of a timeout at stopping an opposing run in the NBA.* Annals of Applied Statistics 16(3). [arXiv:2011.11691](https://arxiv.org/abs/2011.11691) | A run is a **9+ point swing within 2 minutes**. Calling a timeout during an opponent's run is, if anything, slightly *harmful* (≈ −0.35 points). Runs tend to end on their own (regression to the mean). | The momentum panel shows runs for context. The "Why" panel warns against chasing a run. |
| *An Examination of Timeout Value, Strategy, and Momentum in NCAA Division I Men's Basketball* (USPROC, 2019). [PDF](https://www.causeweb.org/usproc/sites/default/files/usresp/2019-1/An%20Examination%20of%20Timeout%20Value%2C%20Strategy%2C%20and%20Momentum%20in%20NCAA%20Division%201%20Mens%20Basketball.pdf) | A college-specific look at momentum and timeouts. | Further reading. |
| *Momentum Effects in Team Sports* (The American Statistician, 2025). [link](https://www.tandfonline.com/doi/full/10.1080/00031305.2025.2595980) | Hot hand, momentum, and the gambler's fallacy can coexist. Effects are small. | Context. |

**Takeaway for the product:** momentum is great for *describing* a game, and bettors love it, which is exactly why it's a trap. The model shows a momentum meter, current run, and last-4-minutes split, but the projection ignores them unless you change the setting.

## 3. Shooting luck and possession stats

| Source | Finding | Used in the model |
|---|---|---|
| Ken Pomeroy (kenpom.com), as summarized by The Power Rank. [link](https://thepowerrank.com/cbb-analytics/) | Defenses control how many threes opponents *take*, but have little control over how many go in. Opponent 3P% is largely luck, and offensive 3P% also regresses to the mean. Possessions ≈ FGA − OREB + TO + 0.475·FTA. College teams average about 70 possessions and 1.00 points per possession. | `threeRegress = 0.7`: 70% of in-game 3P luck (makes above or below the team's season 3P%) is removed before the model estimates future scoring. |
| Dean Oliver (2004). *Basketball on Paper* (the Four Factors). Revisited in [arXiv:2305.13032](https://arxiv.org/abs/2305.13032) | Shooting (eFG%), turnovers, offensive rebounding, and free-throw rate explain nearly all of offensive efficiency (rough weights 40/25/20/15). Single-game Four Factors are very noisy. | Why the model leans on the pregame line and trusts in-game rates only slowly (`paceTrustMinutes`, `marginTrustMinutes`). |
| Early-season shrinkage (standard practice) | A team's season 3P% after 2 games means little. | `seasonProfile()` blends a team's 3P% with the league average, weighted like 5 extra games. |

## 4. Late-game scoring and fouling

| Source | Finding | Used in the model |
|---|---|---|
| Betting-industry analysis. [BettorsWorld](https://www.bettorsworld.com/betting-2nd-half-college-basketball/) | College second halves average about **8 more points** than first halves, mostly from late fouling in close games. | `halfDiff`. Our backtest showed the extra points land in the **final ~4 minutes** and only when the game is close, so the bonus is concentrated there (`foulWindow`) and scaled by margin (`foulFactor`). |
| *College Basketball: An In-depth Study of the "Foul Up 3" Dilemma.* [arXiv:2402.13289](https://arxiv.org/pdf/2402.13289) | End-of-game fouling strategy is common and changes scoring. | Same. |

## 5. Betting markets

| Source | Finding | Used in the model |
|---|---|---|
| Paul, R. & Weinbach, A. *Market efficiency and NCAA college basketball gambling.* [link](https://www.semanticscholar.org/paper/Market-efficiency-and-NCAA-college-basketball-Paul-Weinbach/504be903465c6fd96b4690224d496ddd5c9814ae) | College basketball spreads are close to efficient. Bettors lean toward favorites and overs. | The pregame line is the model's starting point (the market is the best prior), not something we try to beat before tip-off. |
| *Efficiency in the madness? Examining the betting market for the NCAA tournament* (Journal of Economics and Finance, 2020). [link](https://ideas.repec.org/a/spr/jecfin/v44y2020i3d10.1007_s12197-020-09507-7.html) | 1996–2019 tournament data. The market is mostly efficient. | Same. |
| *NBA Gambling Inefficiencies: A Second Look* (The Sport Journal). [link](https://thesportjournal.org/article/nba-gambling-inefficiencies-a-second-look/) | Public bettors are biased toward high scores and favorites. Informed money mostly corrects it. | Same. |
| Choi & Hui (2014), discussed in *Informational efficiency and behaviour within in-play prediction markets* (Univ. of Reading). [PDF](https://www.reading.ac.uk/web/files/economics/emdp201920.pdf). Also *The reaction to news in live betting*, [arXiv:2108.00821](https://arxiv.org/abs/2108.00821) | In-play markets underreact to ordinary news but **overreact to surprising events**, creating short-lived mispricing in the opposite direction. | The main live strategy: the model doesn't chase runs. When a run has pushed the live line far from the model's fair line, value is usually on the other side. |
| Kelly, J. L. (1956), and fractional Kelly practice. [Wikipedia](https://en.wikipedia.org/wiki/Kelly_criterion), [Circa Sports](https://www.circasports.com/blog/kelly-criterion-for-sports-betting-explained) | Kelly sizing maximizes long-run growth, but full Kelly is very volatile and punishes model error. Pros use ¼ to ½ Kelly. | Stake = **¼ Kelly, capped at 5%** of bankroll (`kellyFraction`, `maxStake`). |

---

## 6. Our backtest

We replayed real 2025–26 men's games (with DraftKings lines from ESPN) through the model at minutes 10, 20, 30, 35, and 38. Settings were tuned on 399 games from January–February 2026, then checked on **268 games the model had never seen** (December 2025 and March 2026).

**Held-out games (268):**

| Minute | Final margin inside model's 80% range | Final total inside 80% range | Total bias (actual − projected) | Brier score, model | Brier score, ESPN win prob. |
|---|---|---|---|---|---|
| 10 | 79% | 79% | +4.8 | 0.177 | 0.175 |
| 20 | 80% | 85% | +2.8 | 0.156 | 0.147 |
| 30 | 76% | 83% | +0.5 | **0.109** | 0.110 |
| 35 | 80% | 87% | +0.1 | **0.076** | 0.079 |
| 38 | 83% | 85% | +2.4 | **0.065** | 0.068 |

How to read this:
- **Calibration is good.** When the model says "80% likely between X and Y", the result lands there about 80% of the time.
- **Win probability matches ESPN's** in the first half and is slightly better from minute 30 on (lower Brier is better).
- **Totals run a little low early** on the held-out set. Treat early-game Over/Under picks with extra caution.
- **The pregame spread is hard to beat:** its error SD was 10.9 points, matching the research.

**What this backtest does *not* show:** that the model makes money. That would need historical **live** odds, which aren't in the free ESPN feed. Matching ESPN's win probability is a sanity check, not a betting edge. The edge has to come from live lines that overreact. Track your own results.

Re-run it any time on the site's **Backtest** page, or tune the numbers in `CONFIG` at the top of `js/model.js`.

## Ideas to make it better

- **Live odds feed:** a paid odds API (e.g. The Odds API) would let the site fill in live lines automatically and enable a true profit backtest.
- **Team ratings:** add tempo-free efficiency ratings (KenPom/Torvik-style) as a second prior when no betting line exists.
- **Possession-level pace:** count possessions from play-by-play instead of using points per minute.
- **Foul trouble and lineups:** star players on the bench change expected efficiency.
- **Women's game:** the backtest above is men's only. The women's game (4 quarters, different fouling rules) should be tuned separately.
