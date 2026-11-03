import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { resolve } from 'node:path';
const server = await createServer({
 configFile:false, root:import.meta.dir,
 plugins:[react(),tailwind()],
 resolve:{alias:{'@':resolve(import.meta.dir,'src')},dedupe:['react','react-dom']},
 server:{host:'127.0.0.1',port:43817,strictPort:true,fs:{allow:[resolve(import.meta.dir,'..')]}},
});
await server.listen(); console.log('PR480_REPRO_READY');
