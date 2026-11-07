import module from 'node:module';

console.log(typeof module)

export const loadModule = () => import(/* webpackChunkName: "rslib-line" */ // line comment
  "node:module");
