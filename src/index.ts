import COS from 'cos-nodejs-sdk-v5'
import type { SliceUploadFileParams, SliceCopyFileResult, CosError, PutObjectResult } from 'cos-nodejs-sdk-v5'
import globby from 'globby'
import type { PluginOption } from 'vite'
import _ from 'lodash'
import fs from 'fs'

export interface Options {
    SecretId: string
    SecretKey: string
    Bucket: string
    Region?: string
    exclude?: RegExp
    /** 并发数 */
    concurrent?: number
    /** key 前缀 */
    prefix?: string
    /** 打包文件目录 */
    distDir?: string
    /** 是否输出日志 */
    log?: boolean
    /** cos 大文件上传方法，不传就用普通方法 */
    cosUploadFileParams?: SliceUploadFileParams
}

function print(isPrint: boolean) {
    return function (message: any) {
        if (isPrint) {
            console.log('cos plugin log = ', message)
        }
    }
}

export default function cosPlugin(options: Options, onSucc?: (res: PutObjectResult | SliceCopyFileResult[]) => void, onFail?: (err: CosError) => {}): PluginOption {
    const {
        SecretId,
        SecretKey,
        Bucket,
        Region = 'ap-guangzhou',
        exclude = /(\.map|\.html)$/,
        concurrent = 50,
        prefix = '',
        distDir = 'dist',
        log = true,
        cosUploadFileParams = void 0,
    } = options

    const cos = new COS({
        SecretId,
        SecretKey,
    })

    const logger = print(log)

    return {
        name: 'vite-plugin-cos-upload',
        async writeBundle() {
            logger('开始进行 cos 文件上传')
            const files = await globby([`${distDir}/**/*`])
            const chunkedFiles = _.chunk(files, concurrent)
            const res = await Promise.all(
                // 文件组分片 [file1, file2, file3]
                chunkedFiles.map((chunk) => {
                    return new Promise<PutObjectResult | SliceCopyFileResult[]>((resolve, reject) => {
                        const promises = chunk.filter(file => {
                            const isExcluded = exclude.test(file)
                            if (isExcluded) {
                                logger(`文件被排除${file}`)
                            }
                            return !isExcluded
                        }) .map<Promise<PutObjectResult | SliceCopyFileResult>>((file) => {
                            const dirPath = file.replace('dist/', '')
                            let preStr = prefix || 'upcos-prefix/'

                            if (!preStr.endsWith('/')) {
                                preStr += '/'
                            }

                            if (preStr.startsWith('/')) {
                                preStr = preStr.substring(1, preStr.length)
                            }

                            const remotePath = preStr + dirPath

                            if (cosUploadFileParams) {
                                return new Promise((resolve, reject) => {
                                    cos.sliceUploadFile(
                                        {
                                            ...cosUploadFileParams,
                                            Bucket,
                                            Region,
                                            Key: remotePath,
                                            FilePath: file,
                                        },
                                        (err, data) => {
                                            if (err) {
                                                logger(`分片上传失败${file}`)
                                                reject(err)
                                            } else {
                                                logger(`分片上传成功${file}`)
                                                resolve(data)
                                            }
                                        }
                                    )
                                })
                            } else {
                                return new Promise((resolve, reject) => {
                                    cos.putObject(
                                        {
                                            Bucket,
                                            Region,
                                            Key: remotePath,
                                            Body: fs.createReadStream(file),
                                        },
                                        (err, data) => {
                                            if (err) {
                                                logger(`上传失败${file}`)
                                                reject(err)
                                            } else {
                                                logger(`上传成功${file}`)
                                                resolve(data)
                                            }
                                        }
                                    )
                                })
                            }
   
                        })
                        return Promise.all(promises)
                            .then((res) => {
                                resolve(res)
                            })
                            .catch((err) => {
                                reject(err as CosError)
                            })
                    })
                })
            ).catch(err => {
                onFail && onFail(err)
            })
            res && onSucc && onSucc(res.flat(1))
        },
    }
}
