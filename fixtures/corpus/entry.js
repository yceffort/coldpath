import {startup} from './startup.js';
import {drawChart, neverDrawn} from './chart.js';
import {registered} from './register.js';
import {label, detail} from './mixed.js';

globalThis.corpus = {
  initial: startup() + label('a'),
  openReport: () => drawChart(1234) + registered(1) + detail(1.5),
  search: async () => (await import('./search.js')).search('ABC'),
  neverDrawn,
};
