from pathlib import Path
import sys,json
root=Path(sys.argv[1]).resolve();out=Path(__file__).resolve().parent
config=root/'tests/rspack-test/rstack.config.mts';backup=out/(root.name+'-rstack.original.mts')
if not backup.exists():backup.write_text(config.read_text())
proof=out/(root.name+'-worker-proof.cjs');body=(out/'binding-proof.cjs').read_text();child=(out/'binding-proof.cjs').as_posix()
proof.write_text('process.env.NAPI_RS_NATIVE_LIBRARY_PATH = process.env.TASK_BINDING_PATH;\n'+body+'\nprocess.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || "") + " --require " + JSON.stringify('+json.dumps(child)+');\n')
s=backup.read_text().replace('const setupFilesAfterEnv = [','const setupFilesAfterEnv = [\n    '+json.dumps(proof.as_posix())+',').replace('retry: process.env.CI ? 3 : 0,','retry: 0,');config.write_text(s)
