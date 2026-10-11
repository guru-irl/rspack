const path = require('node:path');

module.exports = {
  experiments: { nativeWatcher: true },
  plugins: [
    {
      apply(compiler) {
        let step = -1;
        let latePath;

        compiler.hooks.done.tap('DoneAddedWatchDependency', (stats) => {
          step++;
          latePath = path.join(
            compiler.context,
            step === 0 ? 'late-a.txt' : 'late-b.txt',
          );
          // Do not read the facade after adding: watch delivery must flush it.
          stats.compilation.fileDependencies.add(latePath);
        });

        compiler.hooks.afterEnvironment.tap('DoneAddedWatchDependency', () => {
          const watchFileSystem = compiler.watchFileSystem;
          const originalWatch = watchFileSystem.watch;
          watchFileSystem.watch = function (...args) {
            const files = args[0];
            // The first native delivery uses full membership. Step 1 is the
            // discriminating delivery, when native registration uses .added.
            if (step === 1) {
              expect([...files.added]).toContain(latePath);
            }
            return originalWatch.apply(this, args);
          };
        });
      },
    },
  ],
};
