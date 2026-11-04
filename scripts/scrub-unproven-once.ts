import { loadBook, saveBook } from "../src/copytrade/store.js";
import { scrubExcessUnprovenOpens, equityOf, markBook } from "../src/copytrade/paperBook.js";

async function main() {
  const root = process.cwd();
  const now = new Date();
  let book = await loadBook(root);
  const before = equityOf(book);
  const scrub = scrubExcessUnprovenOpens(book, now);
  book = scrub.book;
  const marked = await markBook(book, now);
  book = marked.book;
  const after = equityOf(book);
  await saveBook(book, root);
  const open = book.positions.filter((p) => p.status === "open");
  console.log(
    JSON.stringify(
      {
        scrubbed: scrub.closed.map((p) => ({
          label: p.sourceWalletLabel,
          symbol: p.symbol,
          pnl: p.realizedPnlUsd,
          reason: p.closeReason,
        })),
        equityBefore: +before.equityUsd.toFixed(2),
        equityAfter: +after.equityUsd.toFixed(2),
        realized: +after.realizedPnlUsd.toFixed(2),
        unrealized: +after.unrealizedPnlUsd.toFixed(2),
        cash: +book.cashUsd.toFixed(2),
        open: open.map((p) => ({
          label: p.sourceWalletLabel,
          symbol: p.symbol,
          size: p.sizeUsd,
          u: +(p.unrealizedPnlUsd ?? 0).toFixed(2),
        })),
        markClosed: marked.closed,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
