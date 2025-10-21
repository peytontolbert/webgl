"""
Jenkins hash implementation for GTA5 file names
Based on CodeWalker's implementation
"""

def jenkins_hash(key: str) -> int:
    """
    Calculate Jenkins hash for a string
    
    Args:
        key (str): String to hash
        
    Returns:
        int: 32-bit hash value
    """
    if not key:
        return 0
        
    # Convert string to lowercase
    key = key.lower()
    
    # Initialize hash
    hash_val = 0
    
    # Process each character
    for c in key:
        hash_val += ord(c)
        hash_val &= 0xFFFFFFFF
        hash_val += (hash_val << 10)
        hash_val &= 0xFFFFFFFF
        hash_val ^= (hash_val >> 6)
        hash_val &= 0xFFFFFFFF
        
    # Final mixing
    hash_val += (hash_val << 3)
    hash_val &= 0xFFFFFFFF
    hash_val ^= (hash_val >> 11)
    hash_val &= 0xFFFFFFFF
    hash_val += (hash_val << 15)
    hash_val &= 0xFFFFFFFF
    
    return hash_val

def jenkins_hash_filename(filename: str) -> int:
    """
    Calculate Jenkins hash for a filename, removing extension first
    
    Args:
        filename (str): Filename to hash
        
    Returns:
        int: 32-bit hash value
    """
    # Remove extension if present
    if '.' in filename:
        filename = filename.rsplit('.', 1)[0]
        
    return jenkins_hash(filename) 