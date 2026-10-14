# Run the staging loop

1. Confirm the product kill switch is inactive.
2. Run `pnpm amp -- doctor`; stop on any failure.
3. Run `pnpm amp -- demo --env staging`.
4. Confirm the output says `externalMessagesSent: 0` and `moneyMovedCents: 0`.
5. Open the final receipt and report any partial simulation honestly.

Never switch this procedure to production. Production launch remains owner-controlled.
