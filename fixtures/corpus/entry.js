import {startup} from './startup.js';
import {drawChart, neverDrawn} from './chart.js';
import {registered} from './register.js';
import {label, detail} from './mixed.js';
import legacy from './legacy.cjs';

globalThis.corpus = {
  initial: startup() + label('a'),
  openReport: () => drawChart(1234) + registered(1) + detail(1.5) + legacy.format(2),
  search: async () => (await import('./search.js')).search('ABC'),
  neverDrawn,
};
