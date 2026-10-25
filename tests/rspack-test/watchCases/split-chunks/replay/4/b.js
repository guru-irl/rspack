import shared from "./shared";
export const lazy = import(/* webpackChunkName: "lazy" */ "./lazy").then(module => module.default);
export default shared;
