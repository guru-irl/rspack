const fs = require("fs");
const { load } = require("./loader.tsx");

it("keeps main's chunk output when magic comments occur on both sides", async () => {
	const name = "a.js";
	const value = await import(/* webpackChunkName: "line-both" */ // ordinary comment
		`./ctx/${name}` /* webpackInclude: /a\.js$/ */ // ordinary comment
	);
	expect(value.default).toBe("a");
	expect(fs.readdirSync(__dirname).some(file => file.startsWith("line-both"))).toBe(false);
});

it("bundles a partially parenthesized require argument", () => {
	const value = require(/* webpackIgnore: true */ // ordinary comment
		("./require-parity") + ".js"
	);
	expect(value).toBe("bundled");
	const wrapped = require((/* webpackIgnore: true */ // ordinary comment
		("./require-parity") + ".js"));
	expect(wrapped).toBe("bundled");
});

it("keeps chunk names when a line comment follows a magic comment", async () => {
	const source = await import(/* webpackChunkName: "line-after" */ // ordinary comment
		"./source"
	);
	const parenthesized = await import(/* webpackChunkName: "line-after-parenthesized" */ // ordinary comment
		("./parenthesized")
	);

	expect(source.default).toBe("source");
	expect(parenthesized.default).toBe("parenthesized");
	expect(await load()).toBe("loader");
	const files = fs.readdirSync(__dirname);
	expect(files).toContain("line-after.js");
	expect(files).toContain("line-after-parenthesized.js");
	expect(files).toContain("line-after-loader.js");
});
