const fs = require("fs");
const { load } = require("./loader.tsx");

it("keeps chunk names when a line comment follows a magic comment", async () => {
	const source = await import(/* webpackChunkName: "line-after" */ // ordinary comment
		"./source"
	);

	expect(source.default).toBe("source");
	expect(await load()).toBe("loader");
	const files = fs.readdirSync(__dirname);
	expect(files).toContain("line-after.js");
	expect(files).toContain("line-after-loader.js");
});
