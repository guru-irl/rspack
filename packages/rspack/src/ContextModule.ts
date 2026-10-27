import binding from '@rspack/binding';
import type { Source } from 'webpack-sources';
import { defineCoreModuleProperty } from './util/moduleObjectShapeState';
import { SourceAdapter } from './util/source';
import { MODULE_IDENTIFIER_SYMBOL } from './util/symbols';

defineCoreModuleProperty(binding.ContextModule.prototype, 'identifier', {
  enumerable: true,
  configurable: true,
  value(this: binding.Module): string {
    // @ts-expect-error
    return this[MODULE_IDENTIFIER_SYMBOL];
  },
});
defineCoreModuleProperty(binding.ContextModule.prototype, 'originalSource', {
  enumerable: true,
  configurable: true,
  value(this: binding.ContextModule) {
    const originalSource = this._originalSource();
    if (originalSource) {
      return SourceAdapter.fromBinding(originalSource);
    }
    return null;
  },
});
defineCoreModuleProperty(binding.ContextModule.prototype, 'emitFile', {
  enumerable: true,
  configurable: true,
  value(
    this: binding.ContextModule,
    filename: string,
    source: Source,
    assetInfo?: binding.AssetInfo,
  ) {
    return this._emitFile(filename, SourceAdapter.toBinding(source), assetInfo);
  },
});

export { ContextModule } from '@rspack/binding';
