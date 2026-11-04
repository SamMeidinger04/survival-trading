/** Print learning-mode analysis of the paper copy book. Read-only. */
import { analyzeBook, formatReport } from "../copytrade/learning.js";
import { loadBook } from "../copytrade/store.js";

const book = await loadBook(process.cwd());
console.log(formatReport(analyzeBook(book)));
if (book.learningTuning) {
  console.log("\nActive auto-tune state:");
  console.log(JSON.stringify(book.learningTuning, null, 2));
}
