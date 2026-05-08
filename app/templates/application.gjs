import { pageTitle } from 'ember-page-title';
import MobileScanner from 'scanner/components/mobile-scanner';

function noop() {}

<template>
  {{pageTitle "Scanner"}}

  <MobileScanner @onScan={{noop}} @onClose={{noop}} />

  {{outlet}}
</template>
