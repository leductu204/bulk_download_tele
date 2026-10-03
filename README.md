# Telegram TXT Downloader

Chrome/Edge Manifest V3 extension for downloading `.txt` files from the Telegram Web channel currently open in the browser.

## Cài đặt

1. Mở `chrome://extensions` hoặc `edge://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và chọn thư mục `telegram-txt-downloader`.
4. Đăng nhập Telegram Web bằng tay, mở channel cần tải, mở tab **Files**.
5. Bấm **Tải .txt** trên panel ở góc phải dưới.

Sau mỗi lần sửa code: bấm Reload extension rồi **F5 trang Telegram** (bắt buộc).

## Cách hoạt động

Telegram Web bỏ qua click do script tạo ra, nên extension bấm vào từng file bằng
click chuột thật qua `chrome.debugger`. Trong lúc tải, Chrome hiện thanh
"đang gỡ lỗi trình duyệt này"; bấm Hủy trên thanh đó sẽ dừng việc bấm.

Files are saved under `Downloads/<thư mục bạn nhập>` (mặc định
`Downloads/telegram-txt/<channel-name>/`). Muốn lưu sang ổ khác (D:, E:…), đổi
vị trí tải xuống trong Cài đặt Chrome > Tải xuống. Tắt "Hỏi nơi lưu từng tệp"
để không bị hỏi với từng file.

- **Đếm dung lượng**: quét danh sách và cộng dung lượng mà không tải.
- **Từ file số / Số file**: chọn đoạn cần tải (file số 1 là file mới nhất).
- **Bỏ qua file đã tải**: chỉ file Chrome báo tải xong mới được ghi lịch sử, nên
  mỗi lần bấm sẽ tải tiếp phần còn lại.
- **Song song**: số file tải cùng lúc.

Extension chỉ xử lý DOM của channel đang mở. Nó không đọc, lưu hoặc gửi
username/password.

## Giới hạn hiện tại

Telegram Web thay đổi DOM theo phiên bản. Nếu channel dùng layout đặc biệt, cần
cập nhật selector trong `content.js`.
