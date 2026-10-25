namespace BotMatchStats.Core;

/// <summary>
/// Fixed-capacity row buffer used on the game thread. It never grows: rows past capacity are
/// counted in <see cref="Dropped"/> and reported in the file, so a runaway round cannot allocate.
/// </summary>
public sealed class FixedBuffer<T> where T : struct
{
    private readonly T[] _items;
    public int Count { get; private set; }
    public int Dropped { get; private set; }

    public FixedBuffer(int capacity) => _items = new T[capacity];

    public int Capacity => _items.Length;

    /// <summary>Returns the index of the added row, or -1 when the buffer is full.</summary>
    public int Add(in T row)
    {
        if (Count == _items.Length) { Dropped++; return -1; }
        _items[Count] = row;
        return Count++;
    }

    public ref T this[int i] => ref _items[i];

    public ReadOnlySpan<T> Span => new(_items, 0, Count);

    public void Clear() { Count = 0; Dropped = 0; }
}

/// <summary>
/// Growable row store used by the worker for a whole match. Capacity is kept across matches so a
/// long session reuses the same arrays; <see cref="HardCap"/> bounds memory if a match runs away.
/// </summary>
public sealed class GrowBuffer<T> where T : struct
{
    private T[] _items;
    public int Count { get; private set; }
    public int Dropped { get; private set; }
    public int HardCap { get; }

    public GrowBuffer(int initial, int hardCap)
    {
        _items = new T[initial];
        HardCap = hardCap;
    }

    public void Append(ReadOnlySpan<T> rows)
    {
        int room = HardCap - Count;
        if (rows.Length > room) { Dropped += rows.Length - room; rows = rows[..room]; }
        if (rows.Length == 0) return;
        int need = Count + rows.Length;
        if (need > _items.Length)
        {
            int cap = Math.Min(HardCap, Math.Max(need, _items.Length * 2));
            Array.Resize(ref _items, cap);
        }
        rows.CopyTo(_items.AsSpan(Count));
        Count = need;
    }

    public void Add(in T row) => Append(new ReadOnlySpan<T>(in row));

    public ref T this[int i] => ref _items[i];

    public ReadOnlySpan<T> Span => new(_items, 0, Count);

    public void Clear() { Count = 0; Dropped = 0; }
}
