$urls = @(
    'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cloud-images/wsl/noble/current/noble-server-cloudimg-amd64-wsl.rootfs.tar.gz',
    'https://mirrors.ustc.edu.cn/ubuntu-cloud-images/wsl/noble/current/noble-server-cloudimg-amd64-wsl.rootfs.tar.gz',
    'https://mirrors.aliyun.com/ubuntu-cloud-images/wsl/noble/current/noble-server-cloudimg-amd64-wsl.rootfs.tar.gz',
    'https://mirrors.bfsu.edu.cn/ubuntu-cloud-images/wsl/noble/current/noble-server-cloudimg-amd64-wsl.rootfs.tar.gz',
    'https://cloud-images.ubuntu.com/wsl/noble/current/noble-server-cloudimg-amd64-wsl.rootfs.tar.gz'
)

foreach ($url in $urls) {
    try {
        $res = Invoke-WebRequest -Uri $url -Method Head -TimeoutSec 10
        $size = [math]::Round($res.ContentLength / 1MB, 1)
        Write-Host "OK  $($res.StatusCode)  ${size}MB  $url"
    } catch {
        Write-Host "FAIL  $url"
    }
}
