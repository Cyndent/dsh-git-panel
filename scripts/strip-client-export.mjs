import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../lib/client.js', import.meta.url)
let text = await readFile(file, 'utf8')

// 浏览器半区由宿主当经典脚本直接下发。tsc 在少数配置下会补一个
// `export {}`；它会让浏览器把整份脚本当模块而拒绝执行。
text = text.replace(/\r?\nexport \{\};?\s*$/u, '\n')

await writeFile(file, text)
