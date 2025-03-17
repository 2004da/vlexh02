const net = require('net');
const http = require('http');
const { Readable } = require('stream');

// 核心配置
const SETTINGS = {
    ['UUID']: '0cf85927-2c71-4e87-9df3-b1eb7d5a9e1b', // vl1ss UUID
    ['LOG_LEVEL']: 'info',  // 改为 info 级别，减少调试信息
    ['BUFFER_SIZE']: '128', // 缓冲区大小 KiB
    ['XH1TP_PATH']: '/xblog', // XH1TP 路径
}

// 基础工具函数
function validate_uuid(left, right) {
    for (let i = 0; i < 16; i++) {
        if (left[i] !== right[i]) return false
    }
    return true
}

function concat_typed_arrays(first, ...args) {
    if (!args || args.length < 1) return first
    let len = first.length
    for (let a of args) len += a.length
    const r = new first.constructor(len)
    r.set(first, 0)
    len = first.length
    for (let a of args) {
        r.set(a, len)
        len += a.length
    }
    return r
}

// 修改日志函数
function log(type, ...args) {
    // 日志级别定义
    const levels = {
        'debug': 0,
        'info': 1,
        'error': 2
    };

    // 获取当前配置的日志级别
    const configLevel = levels[SETTINGS.LOG_LEVEL] || 1; // 默认为 info
    const messageLevel = levels[type] || 0;

    // 只输出大于等于配置级别的日志
    if (messageLevel >= configLevel) {
        const time = new Date().toISOString();
        console.log(`[${time}] [${type}]`, ...args);
    }
}

// VL1SS 协议解析
function parse_uuid(uuid) {
    uuid = uuid.replaceAll('-', '')
    const r = []
    for (let index = 0; index < 16; index++) {
        r.push(parseInt(uuid.substr(index * 2, 2), 16))
    }
    return r
}

async function read_vl1ss_header(reader, cfg_uuid_str) {
    // 移除调试日志，只保留连接信息
    let readed_len = 0
    let header = new Uint8Array()

    // prevent inner_read_until() throw error
    let read_result = { value: header, done: false }
    async function inner_read_until(offset) {
        if (read_result.done) {
            throw new Error('header length too short')
        }
        const len = offset - readed_len
        if (len < 1) {
            return
        }
        read_result = await read_atleast(reader, len)
        readed_len += read_result.value.length
        header = concat_typed_arrays(header, read_result.value)
    }

    await inner_read_until(1 + 16 + 1)

    const version = header[0]
    const uuid = header.slice(1, 1 + 16)
    const cfg_uuid = parse_uuid(cfg_uuid_str)
    if (!validate_uuid(uuid, cfg_uuid)) {
        throw new Error(`invalid UUID`)
    }
    const pb_len = header[1 + 16]
    const addr_plus1 = 1 + 16 + 1 + pb_len + 1 + 2 + 1
    await inner_read_until(addr_plus1 + 1)

    const cmd = header[1 + 16 + 1 + pb_len]
    const COMMAND_TYPE_TCP = 1
    if (cmd !== COMMAND_TYPE_TCP) {
        throw new Error(`unsupported command: ${cmd}`)
    }

    const port = (header[addr_plus1 - 1 - 2] << 8) + header[addr_plus1 - 1 - 1]
    const atype = header[addr_plus1 - 1]

    const ADDRESS_TYPE_IPV4 = 1
    const ADDRESS_TYPE_STRING = 2
    const ADDRESS_TYPE_IPV6 = 3
    let header_len = -1
    if (atype === ADDRESS_TYPE_IPV4) {
        header_len = addr_plus1 + 4
    } else if (atype === ADDRESS_TYPE_IPV6) {
        header_len = addr_plus1 + 16
    } else if (atype === ADDRESS_TYPE_STRING) {
        header_len = addr_plus1 + 1 + header[addr_plus1]
    }
    if (header_len < 0) {
        throw new Error('read address type failed')
    }
    await inner_read_until(header_len)

    const idx = addr_plus1
    let hostname = ''
    if (atype === ADDRESS_TYPE_IPV4) {
        hostname = header.slice(idx, idx + 4).join('.')
    } else if (atype === ADDRESS_TYPE_STRING) {
        hostname = new TextDecoder().decode(
            header.slice(idx + 1, idx + 1 + header[idx]),
        )
    } else if (atype === ADDRESS_TYPE_IPV6) {
        hostname = header
            .slice(idx, idx + 16)
            .reduce(
                (s, b2, i2, a) =>
                    i2 % 2 ? s.concat(((a[i2 - 1] << 8) + b2).toString(16)) : s,
                [],
            )
            .join(':')
    }
    
    if (!hostname) {
        log('error', 'Failed to parse hostname');
        throw new Error('parse hostname failed')
    }
    
    log('info', `VL1SS connection to ${hostname}:${port}`);
    return {
        hostname,
        port,
        data: header.slice(header_len),
        resp: new Uint8Array([version, 0]),
    }
}

// 添加 read_atleast 函数
async function read_atleast(reader, n) {
    const buffs = []
    let done = false
    while (n > 0 && !done) {
        const r = await reader.read()
        if (r.value) {
            const b = new Uint8Array(r.value)
            buffs.push(b)
            n -= b.length
        }
        done = r.done
    }
    if (n > 0) {
        throw new Error(`not enough data to read`)
    }
    return {
        value: concat_typed_arrays(...buffs),
        done,
    }
}

// 添加 parse_header 函数
async function parse_header(uuid_str, client) {
    log('debug', 'Starting to parse VL1SS header');
    const reader = client.readable.getReader()
    try {
        const vl1ss = await read_vl1ss_header(reader, uuid_str)
        log('debug', 'VL1SS header parsed successfully');
        return vl1ss
    } catch (err) {
        log('error', `VL1SS header parse error: ${err.message}`);
        throw new Error(`read vl1ss header error: ${err.message}`)
    } finally {
        reader.releaseLock()
    }
}

// 添加 connect_remote 函数
async function connect_remote(hostname, port) {
    const timeout = 8000;
    try {
        const conn = await timed_connect(hostname, port, timeout);
        log('info', `Connected to ${hostname}:${port}`);
        return conn;
    } catch (err) {
        log('error', `Connection failed: ${err.message}`);
        throw err;
    }
}

// 添加 timed_connect 函数
function timed_connect(hostname, port, ms) {
    return new Promise((resolve, reject) => {
        const conn = net.createConnection({ host: hostname, port: port })
        const handle = setTimeout(() => {
            reject(new Error(`connect timeout`))
        }, ms)
        conn.on('connect', () => {
            clearTimeout(handle)
            resolve(conn)
        })
        conn.on('error', (err) => {
            clearTimeout(handle)
            reject(err)
        })
    })
}

// 网络传输
function pipe_relay() {
    async function pump(src, dest, first_packet) {
        log('debug', `Starting relay with first packet length: ${first_packet.length}`);
        if (first_packet.length > 0) {
            if (dest.write) {
                // Node.js Stream
                await new Promise((resolve, reject) => {
                    dest.write(first_packet, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else {
                // Web Stream
                const writer = dest.writable.getWriter();
                try {
                    await writer.write(first_packet);
                } finally {
                    writer.releaseLock();
                }
            }
        }
        
        try {
            if (src.pipe) {
                // Node.js Stream
                await new Promise((resolve, reject) => {
                    src.pipe(dest);
                    src.on('end', resolve);
                    src.on('error', reject);
                });
            } else {
                // Web Stream
                await src.readable.pipeTo(dest.writable);
            }
        } catch (err) {
            log('error', 'Relay error:', err.message);
            throw err;
        }
    }
    return pump;
}

// XH1TP 客户端
function create_xh1tp_client(cfg, buff_size, nodeReadableStream) {
    log('debug', 'Creating XH1TP client');
    
    // 将 Node.js 可读流转换为 Web Streams API 可读流
    const readable = new ReadableStream({
        start(controller) {
            nodeReadableStream.on('data', (chunk) => {
                controller.enqueue(chunk);
            });
            nodeReadableStream.on('end', () => {
                controller.close();
            });
            nodeReadableStream.on('error', (err) => {
                controller.error(err);
            });
        }
    });

    const buff_stream = new TransformStream({
        transform(chunk, controller) {
            controller.enqueue(chunk)
        },
    })

    const headers = {
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-store',
        Connection: 'Keep-Alive',
        'Content-Type': 'application/grpc',
        // 添加 stream-one 模式所需的头
        'X-Request-Id': Math.random().toString(36).substring(2),
        'X-Response-Id': '1',
        'X-Stream-Mode': 'one'
    }

    const resp = new Response(buff_stream.readable, { 
        status: 200,
        headers: headers 
    })
    log('debug', 'XH1TP client created with headers:', headers);
    
    return {
        readable: readable,
        writable: buff_stream.writable,
        resp,
    }
}

// 核心处理逻辑
async function handle_client(cfg, client) {
    try {
        log('info', 'New client connection received');
        const vl1ss = await parse_header(cfg.UUID, client)
        log('info', `Connecting to remote: ${vl1ss.hostname}:${vl1ss.port}`);
        const remote = await connect_remote(vl1ss.hostname, vl1ss.port)
        log('info', 'Remote connection established');
        relay(cfg, client, remote, vl1ss)
        return true
    } catch (err) {
        log('error', 'Client handling error:', err.message);
        client.close && client.close()
    }
    return false
}

// 修改 socketToWebStream 函数
function socketToWebStream(socket) {
    let readController;
    let writeController;
    
    socket.on('error', (err) => {
        log('error', 'Socket error:', err.message);
        readController?.error(err);
        writeController?.error(err);
    });

    return {
        readable: new ReadableStream({
            start(controller) {
                readController = controller;
                socket.on('data', (chunk) => {
                    try {
                        controller.enqueue(chunk);
                    } catch (err) {
                        log('error', 'Read controller error:', err.message);
                    }
                });
                socket.on('end', () => {
                    try {
                        controller.close();
                    } catch (err) {
                        log('error', 'Read controller close error:', err.message);
                    }
                });
            },
            cancel() {
                socket.destroy();
            }
        }),
        writable: new WritableStream({
            start(controller) {
                writeController = controller;
            },
            write(chunk) {
                return new Promise((resolve, reject) => {
                    if (socket.destroyed) {
                        reject(new Error('Socket is destroyed'));
                        return;
                    }
                    socket.write(chunk, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            },
            close() {
                if (!socket.destroyed) {
                    socket.end();
                }
            },
            abort(err) {
                socket.destroy(err);
            }
        })
    };
}

// 修改 relay 函数
function relay(cfg, client, remote, vl1ss) {
    const pump = pipe_relay();
    let isClosing = false;
    
    const remoteStream = socketToWebStream(remote);
    
    function cleanup() {
        if (!isClosing) {
            isClosing = true;
            try {
                remote.destroy();
            } catch (err) {
                // 忽略常规断开错误
                if (!err.message.includes('aborted') && 
                    !err.message.includes('socket hang up')) {
                    log('error', `Cleanup error: ${err.message}`);
                }
            }
        }
    }

    const uploader = pump(client, remoteStream, vl1ss.data)
        .catch(err => {
            // 只记录非预期错误
            if (!err.message.includes('aborted') && 
                !err.message.includes('socket hang up')) {
                log('error', `Upload error: ${err.message}`);
            }
        })
        .finally(() => {
            client.reading_done && client.reading_done();
        });

    const downloader = pump(remoteStream, client, vl1ss.resp)
        .catch(err => {
            // 只记录非预期错误
            if (!err.message.includes('aborted') && 
                !err.message.includes('socket hang up')) {
                log('error', `Download error: ${err.message}`);
            }
        });

    downloader
        .finally(() => uploader)
        .finally(cleanup);
}

// HTTP 服务器
const server = http.createServer((req, res) => {
    log('info', `Received ${req.method} request to ${req.url}`);
    
    if (
        req.method === 'POST' &&
        req.url.includes(SETTINGS.XH1TP_PATH)
    ) {
        log('info', 'Valid XH1TP request received');
        const client = create_xh1tp_client(SETTINGS, 0, req);
        
        // 处理请求中断
        req.on('close', () => {
            log('debug', 'Request closed by client');
        });

        handle_client(SETTINGS, client).then(ok => {
            if (ok) {
                try {
                    if (!res.headersSent) {
                        res.writeHead(client.resp.status, client.resp.headers);
                        const readable = Readable.from(client.resp.body);
                        readable.on('error', (err) => {
                            log('error', 'Response stream error:', err.message);
                        });
                        readable.pipe(res);
                    }
                } catch (err) {
                    log('error', 'Response error:', err.message);
                }
            } else {
                if (!res.headersSent) {
                    res.writeHead(404);
                    res.end();
                }
            }
        }).catch(err => {
            log('error', 'Unexpected error:', err);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end();
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

const PORT = process.env.PORT || 30515;
server.listen(PORT, () => {
    log('info', `Server running on port ${PORT}`);
    log('info', `VL1SS UUID: ${SETTINGS.UUID}`);
});
