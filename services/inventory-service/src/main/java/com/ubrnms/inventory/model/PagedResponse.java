package com.ubrnms.inventory.model;

import java.util.List;

/**
 * Generic paginated response envelope returned by list endpoints (WO-008).
 *
 * <p>Standardises pagination metadata across all inventory API responses so that
 * callers can implement generic pagination controls without per-endpoint logic.
 *
 * @param <T> the type of each item in the {@code data} list
 */
public class PagedResponse<T> {

    private final List<T> data;
    private final long    totalElements;
    private final int     totalPages;
    private final int     currentPage;
    private final int     pageSize;

    public PagedResponse(List<T> data, long totalElements, int currentPage, int pageSize) {
        this.data          = data;
        this.totalElements = totalElements;
        this.currentPage   = currentPage;
        this.pageSize      = pageSize == 0 ? 1 : pageSize; // guard against /0
        this.totalPages    = (int) Math.ceil((double) totalElements / this.pageSize);
    }

    public List<T> getData()          { return data; }
    public long    getTotalElements() { return totalElements; }
    public int     getTotalPages()    { return totalPages; }
    public int     getCurrentPage()   { return currentPage; }
    public int     getPageSize()      { return pageSize; }
}
