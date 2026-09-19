# Kế Hoạch Triển Khai: Tool Sắp Xếp Ca Trực Tự Động Theo Tháng

## Giới thiệu & Mục tiêu
Xây dựng một công cụ hỗ trợ người quản lý/phụ trách trực ban tự động phân chia nhân sự thành các nhóm và sắp xếp ca trực trong tháng với các tiêu chí:
1. Chia đều danh sách nhân sự thành các nhóm trực (hoặc phân công thủ công / nhập từ Excel).
2. Xếp lịch trực cho toàn bộ các ngày trong tháng (từ ngày 1 đến ngày cuối tháng).
3. **Ràng buộc tháng trước - tháng sau**: Đảm bảo ngày trực của tháng sau không bị trùng lặp với ngày trực của tháng trước (cùng số ngày $d$, ví dụ: nếu Nhóm 1 trực ngày 5 tháng trước thì ngày 5 tháng sau Nhóm 1 sẽ không trực, đồng thời đảm bảo không bị trực 2 ngày liên tiếp nối giữa cuối tháng trước và đầu tháng sau).
4. Cân bằng công bằng số ca trực cuối tuần (Thứ 7, Chủ Nhật) và ngày lễ giữa các nhóm.
5. Xuất báo cáo ra file Excel (.xlsx) và chế độ xem in ấn / PDF bảng trực chuẩn.

---

## User Review Required

> [!IMPORTANT]
> **1. Nền tảng ứng dụng (Khuyến nghị Web Application chạy offline - Single File HTML/JS)**:
> - Không cần cài đặt bất kỳ môi trường nào (Python, Node.js...), mở được ngay trên trình duyệt Edge/Chrome của máy tính cơ quan/cá nhân.
> - Lưu lịch sử trực các tháng vào bộ nhớ trình duyệt (`localStorage`), tháng sau mở lên là tự động nhận diện lịch tháng trước.
> - Dễ dàng copy/paste từ Excel vào, và xuất ngược lại ra file Excel (.xlsx) chuẩn form mẫu có đóng dấu/ký duyệt.
> - Nếu bạn muốn ứng dụng Python (Desktop GUI / Tkinter), vui lòng phản hồi để điều chỉnh.

> [!WARNING]
> **2. Làm rõ ràng buộc "ngày không trùng với ngày của tháng sau"**:
> Thuật toán sẽ áp dụng 3 quy tắc chống trùng lặp liên tháng:
> - **Quy tắc 1 (Cùng số ngày trong tháng)**: Nếu Nhóm A (hoặc Nhân sự X) trực ngày $d$ ở Tháng $T$ (ví dụ: ngày 15), thì ở Tháng $T+1$ Nhóm A chắc chắn **không** trực vào ngày $d$ (ngày 15).
> - **Quy tắc 2 (Chống dính ca giao thời)**: Nhóm trực ngày cuối cùng của tháng trước (ngày 28/29/30/31) sẽ không bị xếp vào ngày đầu tiên của tháng sau (ngày 1, 2) để đảm bảo thời gian nghỉ hồi phục.
> - **Quy tắc 3 (Đảo ca cuối tuần)**: Nếu tháng trước nhóm trực nhiều ca Thứ 7 / Chủ Nhật, tháng này thuật toán sẽ ưu tiên đẩy ca cuối tuần cho các nhóm khác để đảm bảo công bằng.

---

## Open Questions

> [!NOTE]
> Xin bạn phản hồi thêm một số chi tiết để tool hoàn thiện sát nhất với nhu cầu thực tế:
> 1. **Mô hình ca trực mỗi ngày**:
>    - Mỗi ngày có 1 ca duy nhất (1 nhóm trực cả ngày 24h)?
>    - Hay chia thành nhiều ca (ví dụ: Ca Sáng, Ca Chiều, Ca Đêm)?
> 2. **Cơ cấu thành viên trong nhóm**:
>    - Các thành viên có vai trò khác nhau (ví dụ: Trưởng ca / Phó ca / Chiến sĩ / Nhân viên) hay tất cả các thành viên trong nhóm có vai trò tương đương nhau?
> 3. **Nhóm cố định hay chia lại mỗi tháng**:
>    - Nhóm trực có cố định qua các tháng (ví dụ: Tổ 1, Tổ 2, Tổ 3...) hay mỗi tháng chia lại thành viên mới?

---

## Proposed Changes

Dự kiến triển khai ứng dụng dạng Web Application hiện đại, đóng gói độc lập trong 1 thư mục dễ sử dụng (`duty-scheduler/`):

### Giao diện & Trải nghiệm người dùng (Frontend UI)

#### [NEW] `index.html`
- Giao diện người dùng hiện đại, phong cách chuyên nghiệp:
  - **Khu vực 1: Thiết lập nhân sự & nhóm**:
    - Nhập danh sách tên (nhập từng người, dán từ danh sách, hoặc import từ file Excel).
    - Tùy chọn chia số nhóm: Tự động chia đều hoặc cho phép kéo thả/chỉnh sửa thủ công thành viên từng nhóm.
    - Đặt tên nhóm (Tổ 1, Tổ 2... hoặc Ca A, Ca B...).
  - **Khu vực 2: Cấu hình tháng & quy tắc**:
    - Chọn Tháng/Năm cần xếp lịch.
    - Tùy chọn nạp dữ liệu tháng trước (tự động lấy từ lịch sử đã xếp trước đó, hoặc nhập nhanh nhóm trực ngày cuối/danh sách ngày tháng trước).
    - Bật/tắt các ràng buộc: Tránh trùng ngày $d$ với tháng trước, tránh trực 2 ngày liên tiếp, cân bằng thứ 7/CN.
  - **Khu vực 3: Kết quả & Lịch trực trực quan**:
    - Xem dạng **Lịch tháng (Calendar Grid)**: Mỗi ô hiển thị ngày, thứ, nhóm trực và danh sách thành viên.
    - Xem dạng **Bảng phân công chi tiết (Table View)**: Phù hợp in ấn, kiểm tra.
    - Thống kê công bằng: Tổng số ca của từng nhóm, số ca thứ 7/CN của từng nhóm.
  - **Khu vực 4: Xuất dữ liệu**:
    - Xuất file **Excel (.xlsx)** định dạng chuẩn bảng phân công trực ban.
    - In trực tiếp (Print Preview / Lưu PDF) với style chuẩn khổ giấy A4 ngang.

#### [NEW] `app.js`
- Module xử lý thuật toán xếp ca:
  - **Thuật toán Constraint Satisfaction / Backtracking**:
    - Xoay tua tuần hoàn (Round-robin xoay vòng nhóm) kết hợp offset thích ứng để triệt tiêu việc trùng lặp ngày $d$ giữa 2 tháng.
    - Kiểm tra và loại trừ khả năng trùng ngày cùng số của tháng trước ($Date_{T+1}[d] \neq Group(Date_T[d])$).
    - Đảm bảo thời gian giãn cách giữa các ca trực của cùng 1 nhóm (ít nhất 2-3 ngày tùy số lượng nhóm).
  - Tích hợp thư viện `xlsx.full.min.js` (SheetJS) để đọc & ghi file Excel trực tiếp phía trình duyệt không cần backend.
  - Quản lý bộ nhớ `localStorage` lưu trữ lịch các tháng đã xếp.

#### [NEW] `styles.css`
- Thiết kế giao diện thân thiện, rõ ràng, hỗ trợ in ấn (media print styling) tối ưu cho báo cáo hành chính.

---

## Verification Plan

### Kiểm thử tự động & Thuật toán
1. **Kiểm tra tính đúng đắn của việc chia nhóm**:
   - Nhập 20 người chia 4 nhóm -> mỗi nhóm 5 người.
   - Nhập số lẻ (ví dụ 22 người chia 4 nhóm) -> tự động chia đều hợp lý (2 nhóm 6 người, 2 nhóm 5 người).
2. **Kiểm tra ràng buộc giữa 2 tháng liên tiếp**:
   - Xếp tháng 1 -> Xếp tiếp tháng 2.
   - Chạy hàm kiểm tra tự động duyệt qua từng ngày $d \in [1, 28]$: xác minh $Group_{tháng 2}(d) \neq Group_{tháng 1}(d)$ (100% không trùng ngày).
   - Xác minh ngày 1 tháng 2 khác nhóm với ngày 31 tháng 1.
3. **Kiểm tra cân bằng cuối tuần**:
   - Kiểm tra độ chênh lệch số ca thứ 7/CN giữa các nhóm không vượt quá 1 ca.

### Kiểm thử thủ công
- Mở file `index.html` trên trình duyệt Chrome/Edge.
- Thử nghiệm thao tác nhập danh sách cán bộ, bấm xếp lịch tự động.
- Xuất file Excel và mở bằng Microsoft Excel kiểm tra định dạng và dữ liệu.
