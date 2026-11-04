/** Thin JSON-RPC helper for public Solana HTTP endpoints (read-only). */

export class SolanaRpc {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 25_000,
  ) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "survival-trading-paper-copy/1.0",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429) {
          lastErr = new Error(`RPC HTTP ${res.status} ${res.statusText}`);
          await sleep(800 * (attempt + 1) * (attempt + 1));
          continue;
        }
        if (!res.ok) {
          throw new Error(`RPC HTTP ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as {
          result?: T;
          error?: { code: number; message: string };
        };
        if (body.error) {
          throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
        }
        return body.result as T;
      } catch (e) {
        lastErr = e;
        const msg = String(e);
        if (msg.includes("429") && attempt < 3) {
          await sleep(800 * (attempt + 1) * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  getSignaturesForAddress(
    address: string,
    limit: number,
  ): Promise<
    Array<{
      signature: string;
      blockTime: number | null;
      err: unknown;
      confirmationStatus?: string;
    }>
  > {
    return this.call("getSignaturesForAddress", [address, { limit }]);
  }

  getTransaction(signature: string): Promise<ParsedTx | null> {
    return this.call("getTransaction", [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
    ]);
  }
}

export interface TokenBalanceRow {
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmount: number | null; decimals: number };
}

export interface ParsedTx {
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalanceRow[];
    postTokenBalances?: TokenBalanceRow[];
    logMessages?: string[];
  };
  transaction: {
    message: {
      accountKeys: Array<string | { pubkey: string; signer?: boolean }>;
    };
  };
}

export function accountPubkeys(tx: ParsedTx): string[] {
  return tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
