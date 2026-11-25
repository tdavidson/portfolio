# Capital calls and distributions

## Sizing a call

A call covers what the fund needs to pay before the next call, net of cash it already holds:

| Line | Example |
| --- | --- |
| New investments closing before the next call | 750,000 |
| Follow-ons | 250,000 |
| Management fee for the period (if called, not offset) | 50,000 |
| Fund expenses expected (audit, legal, admin, tax) | 25,000 |
| Less cash on hand above the reserve the fund keeps | (75,000) |
| **Call amount** | **1,000,000** |

Check that the call doesn't exceed any LP's unfunded commitment, the LPA's limit on a single call,
or the investment period (after it, calls are usually limited to follow-ons, fees and expenses).

## Allocating a call

Allocate pro rata to **commitment**, unless the LPA says otherwise (some allocate to unfunded
commitment after a later close, or exclude a GP commitment from fees).

| LP | Commitment | Share | Call |
| --- | --- | --- | --- |
| Example LP A | 5,000,000 | 50.0% | 500,000 |
| Example LP B | 3,000,000 | 30.0% | 300,000 |
| Example LP C | 2,000,000 | 20.0% | 200,000 |
| **Total** | **10,000,000** | **100%** | **1,000,000** |

Each LP's notice states: the amount, the due date (usually 10 business days, per the LPA), the
purpose broken down (investments, fees, expenses), their commitment, called to date including this
call, and unfunded after it, plus wire instructions confirmed by a channel other than the email.

**Wire fraud check.** Wire instructions in a notice should never change without a call to a known
number. Say this whenever you draft a notice.

## Distributions and the waterfall

First separate **return of capital** from **gain**, then apply the LPA's waterfall. A common
European (whole-fund) waterfall:

1. **Return of capital**: 100% to LPs until they have received their contributed capital.
2. **Preferred return** (if any, often 8%): 100% to LPs until they have that return on contributions.
3. **GP catch-up** (if any): a share (often 100%) to the GP until the GP has its carry percentage of
   all profits so far.
4. **Carried interest split**: the rest, e.g. 80% LPs / 20% GP.

An American (deal-by-deal) waterfall runs the same steps per investment, usually with a clawback at
fund end. Many small funds have no preferred return and no catch-up: then it is simply capital
back first, then 80/20.

Show the waterfall as a table with the running balance at each tier, then allocate the LP share
across LPs pro rata to their contributed capital (not commitment), and state each LP's
distribution and the GP's carry. In-kind distributions (shares) are valued at the date of
distribution and need the share count per LP, rounded to whole shares with the remainder stated.

## Checklist before a notice goes out

- [ ] Every LP's line sums to the total, and the total matches the bank or the deal proceeds.
- [ ] Commitment, called to date and unfunded agree with the capital accounts.
- [ ] The waterfall used is the LPA's, with the right pref, catch-up and carry.
- [ ] Wire instructions confirmed out of band.
- [ ] Side letters checked (fee discounts, excused investments, reporting rights).
