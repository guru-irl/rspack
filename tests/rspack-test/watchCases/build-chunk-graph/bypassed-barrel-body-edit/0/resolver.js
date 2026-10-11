export const lookup = () => import("./handler").then(module => module.value);
