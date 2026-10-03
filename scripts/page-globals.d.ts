// Globals that fixture pages define and the checks read inside the browser.
declare var __coldpathApp: {run(interact: boolean): string}
declare var __startupCount: number
declare var __worker: number
declare var __btCorpusReady: boolean | undefined
declare var corpus: {initial: string; openReport(): string; search(): Promise<string>} | undefined
declare var injected: boolean | undefined
declare var never: (() => never) | undefined
