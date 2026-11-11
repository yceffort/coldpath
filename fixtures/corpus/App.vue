<template>
  <p id="result">{{ text }}</p>
</template>

<script lang="ts">
import {startup} from './startup.js'
import {registered} from './register.js'
</script>

<script setup lang="ts">
import {drawChart, neverDrawn} from './chart.js'
import {label, detail} from './mixed.js'
import legacy from './legacy.cjs'

const text: string = startup() + label('a')
globalThis.corpus = {
  initial: text,
  openReport: () => drawChart(1234) + registered(1) + detail(1.5) + legacy.format(2),
  search: async () => (await import('./search.js')).search('ABC'),
  neverDrawn,
}
</script>
