import path from 'node:path';
const root=process.env.BENCH_ROOT;
if (!root) throw Error('BENCH_ROOT required');
export function config(label, plugin) {
 const shared=label==='small'?279:144;
 const groups={};
 for(let j=0;j<shared;j++) groups[`shared${j}`]={test:new RegExp(`/shared-${j}-\\d+\\.js$`),name:`shared-${j}`,chunks:'all',minChunks:2,minSize:0,enforce:true,priority:10};
 return {mode:'production',context:path.join(root,`fixture-${label}`),entry:{index:'./index.js'},devtool:'source-map',
  output:{path:path.join(root,`out-${label}`),filename:'[name].js',chunkFilename:'[name].js',clean:false},
  experiments:{css:true},module:{rules:[{test:/\.css$/,type:'css'}]},
  optimization:{minimize:false,usedExports:false,sideEffects:false,innerGraph:false,concatenateModules:false,chunkIds:'natural',moduleIds:'natural',runtimeChunk:false,splitChunks:{chunks:'all',minSize:0,maxAsyncRequests:Infinity,maxInitialRequests:Infinity,cacheGroups:{default:false,defaultVendors:false,...groups}}},
  plugins:[plugin]};
}
